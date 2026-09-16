-- ============================================================================
-- Migration 178: every payment reaches the posted ledger, not just autopay.
--
-- THE DEFECT. After 171-174 the parent portal answers from the POSTED LEDGER
-- whenever that ledger is "complete". But only two things ever posted a
-- `payment` entry: autopay (172) and a won chargeback (175). Nothing else did —
-- not a parent paying online, not an office recording a check, not a Zelle
-- deposit matched after conversion. Those all land in finance.payments, which
-- the camp's own Billing screen reads directly, so the camp's screen looked
-- right and only the parent saw the wrong number.
--
-- And "complete" only ever tested TUITION: every enrollment had to have a
-- charge posted. Payments were never part of that test. So a family whose
-- tuition was posted and who then paid $2,500 online had a ledger that was
-- complete by that definition, the ledger won, and the parent was told they
-- still owed the $2,500 they had just paid.
--
-- That is the same failure 174 was written to prevent, arriving through the
-- other door: 174 stopped the ledger UNDERSTATING what a family owes, and this
-- stops it OVERSTATING it. Both come from one ledger being fed by one of
-- several paths that move money.
--
-- THE FIX HAS TWO HALVES, and the second one is why this should hold.
--
--   1. POST IT WHERE THE MONEY MOVES. append_camp_payment already takes the row
--      lock and already holds the blob — every online payment on every
--      processor goes through it. It now writes the ledger entry in that same
--      atomic step, so the receipt and the balance cannot disagree. Plus
--      sync_family_ledger_payments for everything written by other paths.
--
--   2. IF A PATH IS STILL MISSED, SAY SO RATHER THAN ANSWER WRONG. The
--      completeness test in get_my_balance now also requires that every
--      recorded payment has a ledger entry. A path nobody remembered to wire up
--      makes the ledger INCOMPLETE, which falls back to the derived figure —
--      which counts finance.payments and bank_deposits and is never short.
--
-- Half 1 alone is the design that just failed: correct until someone adds a
-- seventh way to take money. Half 2 turns that from a wrong balance into a
-- fallback. Keep both.
--
-- ON IDEMPOTENCY. A payment is posted at most once, tested three ways, because
-- three different things have already posted payment entries:
--   * this migration's own entries, id 'le_pay_' || <payment id>;
--   * 172's autopay entries, which carry source.paymentId;
--   * 171's conversion entries, which also carry source.paymentId.
-- Deposits are the awkward one — 171 posted them with an empty source, so they
-- carry no deposit id to match on. 171 is updated here to stamp one. For a camp
-- converted BEFORE that change, a deposit is also treated as covered when an
-- entry has reason 'zelle' with the same amount and date, which is what those
-- rows look like.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ─── 1. the identity of a payment, in one place ─────────────────────────────
-- Two questions, two answers, and conflating them double-credits a family.
--
-- WHICH id does a new entry get? The PROCESSOR's, when there is one. The same
-- Stripe charge is recorded twice by two different paths — Billing's
-- "charge card on file" writes a row with id 'pay_<clock>' the moment the
-- charge returns, and the webhook writes one with id 'pi_<intent>' whenever
-- Stripe gets round to it. Those local ids never match, so keying on them would
-- post the payment twice whenever the webhook won the race. The intent id is
-- the same in both, so that is the key.
--
-- WHICH ids mean "already posted"? All of them. Entries posted before this
-- migration carry whatever reference their writer happened to use: 171's
-- conversion stored the row's own id, autopay (172) stored the processor
-- transaction id. An entry matching ANY of a row's identifiers means that money
-- is already on the ledger.
--
-- A free-text `reference` (an office typing a check number) is deliberately NOT
-- in the coverage set — two cheques can share a number, and treating that as
-- "already posted" would silently drop the second payment. It is only ever used
-- as a last-resort key when a row has no other identifier at all.
CREATE OR REPLACE FUNCTION public.payment_ref_of(p_pay jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT NULLIF(COALESCE(
        NULLIF(p_pay->>'stripeRefundId', ''),
        NULLIF(p_pay->>'byopRefundId', ''),
        NULLIF(p_pay->>'stripePaymentIntentId', ''),
        NULLIF(p_pay->>'byopTransactionId', ''),
        NULLIF(p_pay->>'id', ''),
        NULLIF(p_pay->>'reference', '')
    ), '');
$$;
REVOKE ALL ON FUNCTION public.payment_ref_of(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payment_ref_of(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payment_refs_of(p_pay jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT CASE
        WHEN cardinality(a) > 0 THEN a
        ELSE ARRAY(SELECT NULLIF(p_pay->>'reference', '') WHERE p_pay->>'reference' <> '')
    END
    FROM (SELECT ARRAY(
        SELECT DISTINCT v FROM unnest(ARRAY[
            NULLIF(p_pay->>'id', ''),
            NULLIF(p_pay->>'stripeRefundId', ''),
            NULLIF(p_pay->>'byopRefundId', ''),
            NULLIF(p_pay->>'stripePaymentIntentId', ''),
            NULLIF(p_pay->>'byopTransactionId', '')
        ]) v WHERE v IS NOT NULL) AS a) t;
$$;
REVOKE ALL ON FUNCTION public.payment_refs_of(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payment_refs_of(jsonb) TO authenticated, service_role;


-- ─── 2. should this row post at all, and as what? ───────────────────────────
-- Returns the ledger entry, or NULL when the row must not post:
--   * pending or failed — money that has not arrived is not a payment. 171's
--     conversion skipped these too; this keeps the two in step.
--   * zero amount — nothing to post.
--   * no usable reference — it could never be deduped, so posting it risks
--     double-crediting on the next run. Left unposted, which makes the ledger
--     incomplete and falls back to derived. Loud, not wrong.
--
-- A NEGATIVE amount is how this app records a refund: Billing's refund action
-- pushes a finance.payments row with amount:-X. That becomes a `refund` entry,
-- which RAISES the balance — the family no longer holds that credit.
--
-- STABLE, not IMMUTABLE: it stamps postedAt from now().
CREATE OR REPLACE FUNCTION public.payment_ledger_entry(p_pay jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_ref    text := public.payment_ref_of(p_pay);
    v_amt    numeric := COALESCE((p_pay->>'amount')::numeric, 0);
    v_status text := lower(COALESCE(p_pay->>'status', ''));
    v_method text := lower(COALESCE(p_pay->>'method', ''));
    v_reason text;
BEGIN
    IF v_ref IS NULL THEN RETURN NULL; END IF;
    IF v_status IN ('pending', 'failed', 'processing', 'canceled', 'cancelled') THEN
        RETURN NULL;
    END IF;
    IF v_amt = 0 THEN RETURN NULL; END IF;

    -- The reason is what a camp reads in a statement, so it follows how the
    -- money actually arrived rather than collapsing everything to 'card'.
    v_reason := CASE
        WHEN v_amt < 0                      THEN 'refund'
        WHEN v_method LIKE '%zelle%'        THEN 'zelle'
        WHEN v_method LIKE '%cash%'         THEN 'cash'
        WHEN v_method LIKE '%check%'        THEN 'check'
        WHEN v_method LIKE '%ach%'
          OR v_method LIKE '%bank%'         THEN 'ach'
        ELSE 'card' END;

    RETURN jsonb_build_object(
        'id',       'le_pay_' || v_ref,
        'kind',     CASE WHEN v_amt < 0 THEN 'refund' ELSE 'payment' END,
        'amount',   ROUND(ABS(v_amt), 2),
        'reason',   v_reason,
        'date',     COALESCE(NULLIF(p_pay->>'date', ''),
                             to_char(now(), 'YYYY-MM-DD')),
        'postedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'note',     COALESCE(NULLIF(p_pay->>'notes', ''),
                             CASE WHEN v_amt < 0 THEN 'Refund' ELSE 'Payment' END),
        'by',       'system',
        'source',   jsonb_build_object('paymentId', v_ref));
END;
$$;
REVOKE ALL ON FUNCTION public.payment_ledger_entry(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payment_ledger_entry(jsonb) TO authenticated, service_role;


-- ─── 3. has this family already got this payment? ───────────────────────────
-- Three tests, because three things post payment entries — see the header. Any
-- one of them matching means do not post again.
-- A row with NO usable reference is deliberately reported as NOT covered. It
-- cannot be posted (there is no key to dedupe it by) and it cannot be ignored
-- either — treating it as covered would make it invisible to both the poster
-- and the completeness test, which is the silent hole this migration exists to
-- close. Reported uncovered, it makes the ledger incomplete and the parent gets
-- the derived figure instead.
CREATE OR REPLACE FUNCTION public.family_covers_payment(p_fam jsonb, p_pay jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT cardinality(public.payment_refs_of(p_pay)) > 0
       AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p_fam->'entries') = 'array'
                      THEN p_fam->'entries' ELSE '[]'::jsonb END) e,
               unnest(public.payment_refs_of(p_pay)) r
         WHERE e->>'id' = 'le_pay_' || r
            OR e->'source'->>'paymentId' = r
    );
$$;
REVOKE ALL ON FUNCTION public.family_covers_payment(jsonb, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.family_covers_payment(jsonb, jsonb)
    TO authenticated, service_role;


-- ─── 4. and the same question for a bank deposit ────────────────────────────
-- Zelle/ACH deposits live in their own table, never in the blob. 171 posted
-- them at conversion with an empty source, so a camp converted before this
-- migration has entries that carry no deposit id. The amount+date+reason match
-- is there for exactly those rows and nothing else.
CREATE OR REPLACE FUNCTION public.family_covers_deposit(
    p_fam jsonb, p_dep_id uuid, p_amount numeric, p_date text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p_fam->'entries') = 'array'
                      THEN p_fam->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'id' = 'le_dep_' || p_dep_id::text
            OR e->'source'->>'depositId' = p_dep_id::text
            OR (e->>'reason' = 'zelle'
                AND ROUND(COALESCE((e->>'amount')::numeric, -1), 2) = ROUND(p_amount, 2)
                AND e->>'date' = p_date)
    );
$$;
REVOKE ALL ON FUNCTION public.family_covers_deposit(jsonb, uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.family_covers_deposit(jsonb, uuid, numeric, text)
    TO authenticated, service_role;


-- ─── 5. post everything that is missing ─────────────────────────────────────
-- The catch-up path, for money recorded by something other than
-- append_camp_payment: Billing's Record Payment and refund actions (which save
-- the whole blob from the browser), the CSV import, and every bank deposit.
--
-- Safe to call as often as you like — it posts only what is missing, and the
-- three coverage tests above are what make that true.
CREATE OR REPLACE FUNCTION public.sync_family_ledger_payments(
    p_camp_id    uuid,
    p_family_key text DEFAULT NULL,   -- NULL = every family
    p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_pays    jsonb;
    famRec    record;
    v_fam     jsonb;
    v_entries jsonb;
    v_entry   jsonb;
    v_posted  integer := 0;
    v_skipped integer := 0;
    v_fams    integer := 0;
    v_report  jsonb := '[]'::jsonb;
    v_n       integer;
    e         jsonb;
    d         record;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_pays := COALESCE(v_me->'finance'->'payments', '[]'::jsonb);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      COALESCE(v_me->'families', '{}'::jsonb)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;
        IF p_family_key IS NOT NULL AND famRec.key <> p_family_key THEN CONTINUE; END IF;

        v_fam := famRec.value;
        v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                          THEN v_fam->'entries' ELSE '[]'::jsonb END;
        v_n := 0;

        -- payments recorded in the blob
        FOR e IN SELECT * FROM jsonb_array_elements(v_pays) LOOP
            IF COALESCE(e->>'familyKey', '') <> famRec.key THEN CONTINUE; END IF;
            IF public.family_covers_payment(
                   jsonb_build_object('entries', v_entries), e) THEN
                CONTINUE;
            END IF;
            v_entry := public.payment_ledger_entry(e);
            IF v_entry IS NULL THEN
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;
            v_entries := v_entries || jsonb_build_array(v_entry);
            v_n := v_n + 1;
        END LOOP;

        -- Zelle/ACH deposits, which never lived in the blob at all
        FOR d IN SELECT id, amount_cents, is_reversal,
                        to_char(created_at, 'YYYY-MM-DD') AS on_date
                   FROM bank_deposits
                  WHERE camp_id = p_camp_id AND status = 'posted'
                    AND family_key = famRec.key LOOP
            IF public.family_covers_deposit(
                   jsonb_build_object('entries', v_entries), d.id,
                   ABS(d.amount_cents::numeric / 100), d.on_date) THEN
                CONTINUE;
            END IF;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id',       'le_dep_' || d.id::text,
                'kind',     CASE WHEN d.is_reversal THEN 'refund' ELSE 'payment' END,
                'amount',   ROUND(ABS(d.amount_cents::numeric / 100), 2),
                'reason',   'zelle',
                'date',     d.on_date,
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note',     CASE WHEN d.is_reversal
                                 THEN 'Bank deposit reversed'
                                 ELSE 'Bank deposit' END,
                'by',       'system',
                'source',   jsonb_build_object('depositId', d.id::text)));
            v_n := v_n + 1;
        END LOOP;

        IF v_n > 0 THEN
            v_fams := v_fams + 1;
            v_posted := v_posted + v_n;
            v_report := v_report || jsonb_build_array(jsonb_build_object(
                'famKey', famRec.key, 'name', v_fam->>'name', 'posted', v_n));
            IF NOT p_dry_run THEN
                v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
                v_me := jsonb_set(v_me, ARRAY['families', famRec.key], v_fam, true);
            END IF;
        END IF;
    END LOOP;

    IF NOT p_dry_run AND v_posted > 0 THEN
        UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;

    RETURN jsonb_build_object('success', true, 'dryRun', p_dry_run,
        'posted', v_posted, 'families', v_fams,
        'skippedUnpostable', v_skipped, 'detail', v_report);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_family_ledger_payments(uuid, text, boolean)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sync_family_ledger_payments(uuid, text, boolean)
    TO authenticated, service_role;


-- ─── 6. post it where the money moves ───────────────────────────────────────
-- 168's append_camp_payment, unchanged except that each of its two write paths
-- now also posts the ledger entry. Same lock, same statement, so the receipt
-- and the balance cannot end up disagreeing.
--
-- The STATUS-TRANSITION path matters as much as the append. Stripe sends
-- pending and then succeeded for one intent, so the entry has to appear on the
-- transition, not only on first sight. And a bank payment can go the other way
-- — succeeded, then failed days later when an ACH debit is returned — which
-- posts a REVERSAL rather than deleting anything, because entries are never
-- removed. Without that, a returned payment stays on the ledger as money the
-- camp never kept.
CREATE OR REPLACE FUNCTION public.append_camp_payment(
    p_camp_id         uuid,
    p_payment         jsonb,
    p_dedupe_key      text DEFAULT NULL,
    p_update_on_match jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_fin     jsonb;
    v_pays    jsonb;
    v_exists  boolean := false;
    v_out     jsonb;
    v_hit     boolean := false;
    e         jsonb;
    v_merged  jsonb;
    v_famKey  text;
    v_fam     jsonb;
    v_entries jsonb;
    v_entry   jsonb;
    v_posted  boolean := false;
    v_revId   text;
BEGIN
    IF p_camp_id IS NULL OR p_payment IS NULL OR jsonb_typeof(p_payment) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- Create the row if the camp has never saved Campistry Me, so a first
    -- payment is not lost to a missing blob.
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (p_camp_id, 'campistryMe', '{}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    -- The lock. Held to the end of the function, so the read, the dedupe check
    -- and the write are one atomic step and a concurrent writer waits rather
    -- than overwriting.
    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL OR jsonb_typeof(v_me) <> 'object' THEN v_me := '{}'::jsonb; END IF;

    v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
    IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
    v_pays := COALESCE(v_fin->'payments', '[]'::jsonb);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

    IF p_dedupe_key IS NOT NULL AND p_dedupe_key <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_pays) p
             WHERE p->>'id' = p_dedupe_key
                OR p->>'reference' = p_dedupe_key
                OR p->>'byopTransactionId' = p_dedupe_key
                OR p->>'stripePaymentIntentId' = p_dedupe_key
        ) INTO v_exists;

        IF v_exists THEN
            -- Already here. Two different callers want different things:
            --
            --   p_update_on_match NULL  -> a retried webhook for a charge we
            --                              already recorded. Do nothing.
            --   p_update_on_match SET   -> a STATUS TRANSITION for a payment
            --                              we already have (Stripe sends
            --                              pending, then succeeded or failed
            --                              for the same intent). Patch the row
            --                              in place rather than appending a
            --                              second one for the same charge.
            IF p_update_on_match IS NULL OR jsonb_typeof(p_update_on_match) <> 'object' THEN
                RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                          'updated', false,
                                          'count', jsonb_array_length(v_pays));
            END IF;

            v_out := '[]'::jsonb;
            FOR e IN SELECT * FROM jsonb_array_elements(v_pays) LOOP
                IF NOT v_hit AND (
                       e->>'id' = p_dedupe_key
                    OR e->>'reference' = p_dedupe_key
                    OR e->>'byopTransactionId' = p_dedupe_key
                    OR e->>'stripePaymentIntentId' = p_dedupe_key) THEN
                    v_merged := e || p_update_on_match;
                    v_out := v_out || jsonb_build_array(v_merged);
                    v_hit := true;
                ELSE
                    v_out := v_out || jsonb_build_array(e);
                END IF;
            END LOOP;

            v_fin := jsonb_set(v_fin, '{payments}', v_out, true);
            v_me  := jsonb_set(v_me,  '{finance}',  v_fin, true);

            -- The transition, on the ledger.
            IF v_hit AND v_merged IS NOT NULL THEN
                v_famKey := NULLIF(v_merged->>'familyKey', '');
                IF v_famKey IS NOT NULL THEN
                    v_fam := v_me #> ARRAY['families', v_famKey];
                    IF v_fam IS NOT NULL AND jsonb_typeof(v_fam) = 'object' THEN
                        v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                                          THEN v_fam->'entries' ELSE '[]'::jsonb END;
                        v_entry := public.payment_ledger_entry(v_merged);

                        IF v_entry IS NOT NULL
                           AND NOT public.family_covers_payment(
                                   jsonb_build_object('entries', v_entries), v_merged) THEN
                            -- pending -> succeeded
                            v_entries := v_entries || jsonb_build_array(v_entry);
                            v_posted := true;
                        ELSIF v_entry IS NULL
                              AND public.family_covers_payment(
                                      jsonb_build_object('entries', v_entries), v_merged) THEN
                            -- succeeded -> failed. An ACH debit returned after
                            -- settlement is the real case. Reverse rather than
                            -- remove: the ledger is append-only, and the camp
                            -- needs to see that it happened.
                            v_revId := 'le_payrev_' || public.payment_ref_of(v_merged);
                            IF NOT EXISTS (
                                SELECT 1 FROM jsonb_array_elements(v_entries) x
                                 WHERE x->>'id' = v_revId) THEN
                                v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                                    'id',       v_revId,
                                    'kind',     'refund',
                                    'amount',   ROUND(ABS(COALESCE(
                                                   (v_merged->>'amount')::numeric, 0)), 2),
                                    'reason',   'reversal',
                                    'date',     to_char(now_ts, 'YYYY-MM-DD'),
                                    'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                    'note',     COALESCE(NULLIF(v_merged->>'notes', ''),
                                                         'Payment did not clear'),
                                    'by',       'system',
                                    'source',   jsonb_build_object(
                                                   'paymentId', public.payment_ref_of(v_merged),
                                                   'reverses', 'le_pay_' ||
                                                       public.payment_ref_of(v_merged))));
                                v_posted := true;
                            END IF;
                        END IF;

                        IF v_posted THEN
                            v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
                            v_me := jsonb_set(v_me, ARRAY['families', v_famKey], v_fam, true);
                        END IF;
                    END IF;
                END IF;
            END IF;

            UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
             WHERE camp_id = p_camp_id AND key = 'campistryMe';

            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'updated', true, 'ledgerPosted', v_posted,
                                      'count', jsonb_array_length(v_out));
        END IF;
    END IF;

    v_pays := v_pays || jsonb_build_array(p_payment);
    v_fin  := jsonb_set(v_fin, '{payments}', v_pays, true);
    v_me   := jsonb_set(v_me,  '{finance}',  v_fin,  true);

    -- ...and the ledger entry for it, in this same write.
    v_famKey := NULLIF(p_payment->>'familyKey', '');
    IF v_famKey IS NOT NULL THEN
        v_fam := v_me #> ARRAY['families', v_famKey];
        IF v_fam IS NOT NULL AND jsonb_typeof(v_fam) = 'object' THEN
            v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                              THEN v_fam->'entries' ELSE '[]'::jsonb END;
            v_entry := public.payment_ledger_entry(p_payment);
            IF v_entry IS NOT NULL
               AND NOT public.family_covers_payment(
                       jsonb_build_object('entries', v_entries), p_payment) THEN
                v_fam := jsonb_set(v_fam, '{entries}',
                                   v_entries || jsonb_build_array(v_entry), true);
                v_me := jsonb_set(v_me, ARRAY['families', v_famKey], v_fam, true);
                v_posted := true;
            END IF;
        END IF;
    END IF;

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'alreadyRecorded', false,
                              'updated', false, 'ledgerPosted', v_posted,
                              'count', jsonb_array_length(v_pays));
END;
$$;
REVOKE ALL ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) TO service_role;


-- ─── 7. a ledger missing a payment is INCOMPLETE ────────────────────────────
-- The half that makes the rest survive a path nobody wired up. 174 asked only
-- "does every enrollment have a tuition charge?", so a ledger could be missing
-- every payment a family ever made and still be declared complete — which is
-- precisely how the parent came to be shown money they had already paid.
--
-- The rule is the same as 174's and so is the fallback: anything unaccounted
-- for means answer with the DERIVED figure, which counts finance.payments and
-- bank_deposits directly and is never short.
-- Did money actually move? Separate from payment_ledger_entry because a row can
-- be real money and still be unpostable (no reference to dedupe it by), and
-- those two cases must not be confused: one is correctly absent from the ledger,
-- the other means the ledger cannot be trusted.
CREATE OR REPLACE FUNCTION public.payment_moved_money(p_pay jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE((p_pay->>'amount')::numeric, 0) <> 0
       AND lower(COALESCE(p_pay->>'status', '')) NOT IN
           ('pending', 'failed', 'processing', 'canceled', 'cancelled');
$$;
REVOKE ALL ON FUNCTION public.payment_moved_money(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payment_moved_money(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.family_payments_all_posted(
    p_fam jsonb, p_pays jsonb, p_fam_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(p_pays) = 'array'
                      THEN p_pays ELSE '[]'::jsonb END) e
         WHERE COALESCE(e->>'familyKey', '') = p_fam_key
           -- Only money that actually moved has to be on the ledger; a pending
           -- or failed row is correctly absent from it. A row that moved money
           -- but carries no reference counts as missing, not as excused.
           AND public.payment_moved_money(e)
           AND NOT public.family_covers_payment(p_fam, e)
    );
$$;
REVOKE ALL ON FUNCTION public.family_payments_all_posted(jsonb, jsonb, text) FROM public;
GRANT EXECUTE ON FUNCTION public.family_payments_all_posted(jsonb, jsonb, text)
    TO authenticated, service_role;


-- ─── 8. the parent's balance asks the fuller question ───────────────────────
-- 174's wrapper, unchanged except for the payment pass added to its
-- completeness test and the extra key in what it reports. Replaced in place, so
-- it keeps the LEDGER_WRAPPER_V173 marker that stops 173's rename guard from
-- turning this function into its own callee.
CREATE OR REPLACE FUNCTION public.get_my_balance(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    -- LEDGER_WRAPPER_V173 — the marker migration 173's rename guard looks for.
    -- Do not remove it: without it, re-running 173 renames THIS function to
    -- get_my_balance_derived and the replacement calls itself forever.
    v_base    jsonb;
    v_me      jsonb;
    v_keys    jsonb;
    v_fam     jsonb;
    v_sum     jsonb;
    v_billed  numeric := 0;
    v_paid    numeric := 0;
    v_credits numeric := 0;
    v_allHave boolean := true;
    v_complete boolean := true;
    v_missing jsonb := '[]'::jsonb;
    v_pays    jsonb;
    v_unpaid  jsonb := '[]'::jsonb;
    k         text;
    enr       jsonb;
    v_found   boolean;
BEGIN
    v_base := public.get_my_balance_derived(p_camp_id);
    IF v_base IS NULL OR COALESCE((v_base->>'success')::boolean, false) = false THEN
        RETURN v_base;
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = (v_base->>'camp_id')::uuid AND key = 'campistryMe';
    IF v_me IS NULL THEN RETURN v_base; END IF;

    v_keys := COALESCE(v_base->'familyKeys', '[]'::jsonb);
    IF jsonb_typeof(v_keys) <> 'array' OR jsonb_array_length(v_keys) = 0 THEN
        RETURN v_base;
    END IF;

    FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
        v_fam := v_me #> ARRAY['families', k];
        IF v_fam IS NULL OR NOT public.family_has_ledger(v_fam) THEN
            v_allHave := false;
            EXIT;
        END IF;
        v_sum := public.family_ledger_summary(v_fam);
        v_billed  := v_billed  + COALESCE((v_sum->>'billed')::numeric, 0);
        v_paid    := v_paid    + COALESCE((v_sum->>'paid')::numeric, 0);
        v_credits := v_credits + COALESCE((v_sum->>'credits')::numeric, 0);
    END LOOP;

    -- ── completeness ─────────────────────────────────────────────────────
    -- Every enrollment the derived figure billed must have a posted tuition
    -- charge somewhere in these families' ledgers. A charge that exists on the
    -- camp's screen and not in the ledger is what made a parent's balance read
    -- $0 on a $2,500 registration.
    IF v_allHave THEN
        FOR enr IN SELECT * FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(v_base->'enrollments') = 'array'
                            THEN v_base->'enrollments' ELSE '[]'::jsonb END) LOOP
            v_found := false;
            FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
                IF public.family_has_tuition_entry(
                       v_me #> ARRAY['families', k], enr->>'id') THEN
                    v_found := true;
                    EXIT;
                END IF;
            END LOOP;
            IF NOT v_found THEN
                v_complete := false;
                v_missing := v_missing || jsonb_build_array(enr->>'id');
            END IF;
        END LOOP;

        -- ── and every payment (migration 178) ────────────────────────────
        -- 174 asked only whether every enrollment had a tuition CHARGE, so a
        -- ledger missing every payment a family ever made was still declared
        -- complete — and the parent was shown money they had already paid.
        -- Asking the same question of payments is what closes that.
        v_pays := COALESCE(v_me->'finance'->'payments', '[]'::jsonb);
        FOR k IN SELECT jsonb_array_elements_text(v_keys) LOOP
            IF NOT public.family_payments_all_posted(
                   v_me #> ARRAY['families', k], v_pays, k) THEN
                v_complete := false;
                v_unpaid := v_unpaid || jsonb_build_array(k);
            END IF;
        END LOOP;
    END IF;

    -- Not converted, or converted but behind: hand back the DERIVED answer,
    -- which is never short. `ledger` says which number the caller is looking at
    -- and `ledgerIncomplete` says why, so this is diagnosable from the portal
    -- rather than only from the database.
    IF NOT v_allHave THEN
        RETURN v_base || jsonb_build_object('ledger', false);
    END IF;
    IF NOT v_complete THEN
        RETURN v_base || jsonb_build_object(
            'ledger', false,
            'ledgerIncomplete', true,
            'unpostedEnrollments', v_missing,
            'unpostedPaymentFamilies', v_unpaid);
    END IF;

    -- Complete. The ledger is the balance. It deliberately does NOT re-add bank
    -- deposits: 171's conversion posts them as payment entries, so counting them
    -- here as well would credit a Zelle payment twice.
    RETURN v_base || jsonb_build_object(
        'ledger',  true,
        'billed',  ROUND(v_billed, 2),
        'paid',    ROUND(v_paid, 2),
        'credits', ROUND(v_credits, 2),
        'balance', ROUND(v_billed - v_paid - v_credits, 2)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_balance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_balance(uuid) TO authenticated, service_role;


-- ─── 9. a refund issued OUTSIDE Campistry ───────────────────────────────────
-- A director refunding from the Stripe dashboard rather than from Billing —
-- which people do constantly — produced nothing here at all. Not a ledger
-- entry, not even a payment row. The family kept a credit they no longer had
-- and the camp's own payment list disagreed with its Stripe account.
--
-- charge.refunded was simply not among the events stripe-webhook handled. It is
-- now, and it lands here.
--
-- The entry id is 'le_pay_' || <refund id> — the SAME scheme Billing's own
-- refund action produces, because that action writes a payments row carrying
-- stripeRefundId and section 1 makes that the row's key. So whichever happens
-- first, the other finds it already posted. A refund made in Campistry and
-- echoed back by the webhook is recorded once.
CREATE OR REPLACE FUNCTION public.record_external_refund(
    p_camp_id   uuid,
    p_refund_id text,
    p_refs      text[],
    p_amount    numeric,
    p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    famRec    record;
    v_fam     jsonb;
    v_famKey  text := NULL;
    v_entryId text;
    v_fin     jsonb;
    v_pays    jsonb;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_refund_id, '') = ''
       OR p_refs IS NULL OR array_length(p_refs, 1) IS NULL
       OR NOT (COALESCE(p_amount, 0) > 0) THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe'
     FOR UPDATE;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_entryId := 'le_pay_' || p_refund_id;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      COALESCE(v_me->'families', '{}'::jsonb)) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;

        -- Already recorded, by this function or by Billing's own refund action.
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                          THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
             WHERE e->>'id' = v_entryId
                OR e->'source'->>'paymentId' = p_refund_id
        ) THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'familyKey', famRec.key);
        END IF;
    END LOOP;

    -- Whose money was it? The payment being refunded, found the same way a
    -- chargeback finds it (175) — on a SET of references, because a row carries
    -- whichever one the path that recorded it happened to write.
    SELECT e->>'familyKey' INTO v_famKey
      FROM jsonb_array_elements(
             COALESCE(v_me->'finance'->'payments', '[]'::jsonb)) e
     WHERE COALESCE(e->>'familyKey', '') <> ''
       AND (e->>'stripePaymentIntentId' = ANY(p_refs)
         OR e->>'reference' = ANY(p_refs)
         OR e->>'byopTransactionId' = ANY(p_refs)
         OR e->>'id' = ANY(p_refs))
     LIMIT 1;

    IF v_famKey IS NULL OR v_me #> ARRAY['families', v_famKey] IS NULL THEN
        -- Same rule as a chargeback: never guess. A refund posted against the
        -- wrong family moves a stranger's balance.
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found',
                                  'refs', to_jsonb(p_refs));
    END IF;

    v_fam := v_me #> ARRAY['families', v_famKey];
    v_fam := jsonb_set(v_fam, '{entries}',
        CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
             THEN v_fam->'entries' ELSE '[]'::jsonb END
        || jsonb_build_array(jsonb_build_object(
            'id',       v_entryId,
            'kind',     'refund',
            'amount',   ROUND(p_amount, 2),
            'reason',   'refund',
            'date',     to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note',     COALESCE(p_note, 'Refund issued at the processor'),
            'by',       'system',
            'source',   jsonb_build_object('paymentId', p_refund_id,
                                           'refs', to_jsonb(p_refs)))), true);
    v_me := jsonb_set(v_me, ARRAY['families', v_famKey], v_fam, true);

    -- And a receipt, because a refund taken at the processor left the camp's own
    -- payment list disagreeing with its Stripe account.
    v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
    IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
    v_pays := COALESCE(v_fin->'payments', '[]'::jsonb);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;
    v_fin := jsonb_set(v_fin, '{payments}', v_pays || jsonb_build_array(
        jsonb_build_object(
            'id', 'ref_' || p_refund_id,
            'family', COALESCE(v_fam->>'name', v_famKey),
            'familyKey', v_famKey,
            'amount', -ROUND(p_amount, 2),
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'method', 'Refund',
            'reference', p_refund_id,
            'stripeRefundId', p_refund_id,
            'notes', COALESCE(p_note, 'Refund issued at the processor'),
            'offline', false,
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint)), true);
    v_me := jsonb_set(v_me, '{finance}', v_fin, true);

    UPDATE camp_state_kv SET value = v_me, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryMe';

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'entryId', v_entryId, 'amount', ROUND(p_amount, 2),
        'balance', public.family_ledger_balance(v_fam));
END;
$$;
REVOKE ALL ON FUNCTION public.record_external_refund(uuid, text, text[], numeric, text)
    FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_external_refund(uuid, text, text[], numeric, text)
    TO service_role;


-- ─── Checking it ───────────────────────────────────────────────────────────
--   -- What is missing right now, changing nothing:
--   select sync_family_ledger_payments('<camp>'::uuid, null, true);
--
--   -- Post it:
--   select sync_family_ledger_payments('<camp>'::uuid);
--
--   -- And again — should post 0, because everything is now covered:
--   select sync_family_ledger_payments('<camp>'::uuid);
--
--   -- A family's ledger balance should now agree with its payments:
--   select f.key,
--          family_ledger_balance(f.value) as ledger
--     from camp_state_kv k,
--          lateral jsonb_each(k.value->'families') f
--    where k.camp_id = '<camp>'::uuid and k.key = 'campistryMe';
-- ============================================================================
