-- ════════════════════════════════════════════════════════════════════════════
-- 213 — payments become the record, and stop locking the camp
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHERE WE ARE.
--   208 ✓ payments → rows        (22 camps inSync, 1566.67 = 1566.67)
--   210 ✓ payment readers → rows (sameOrderAndContent, 18 = 18)
--   211 ✓ families → rows        (65 live rows / 5 camps, 2000 = 2000)
--   212 ✓ family readers → rows  (5 readers moved, accessor_leaks false)
--   213   (here) the PAYMENT writers write rows, and the camp-wide lock goes
--   next  the FAMILY writers, then the load test measures the result
--
-- ─── THIS ONE IS A RESTRUCTURE, NOT A SUBSTITUTION ──────────────────────────
-- 212 could extract four money functions verbatim and change one expression
-- each, and a line-by-line diff against the original proved it. This cannot be
-- done that way: append_camp_payment's persistence IS the thing changing. It
-- stops reading the whole document under `FOR UPDATE`, stops rewriting it, and
-- instead dedupes against an indexed column, inserts one row, and locks one
-- family row to post the ledger entry.
--
-- So the proof is different in kind. Every DECISION the function makes is
-- unchanged and asserted expression by expression (the four dedupe fields, the
-- ledger-entry condition, the reversal id and its shape, the covers-payment
-- test), and scripts/pgtests/213_payments_row_truth.sql exercises each branch
-- against a real server: a new payment, a retried webhook, pending → succeeded,
-- succeeded → failed with its reversal, a payment with no familyKey, and two
-- concurrent inserts.
--
-- ─── TWO THINGS 208 GOT WRONG, FIXED HERE ───────────────────────────────────
--
-- 1. PAYMENTS NEED A SOFT DELETE. 208 made the rows append-only, reasoning that
--    a payment is an event and a payment vanishing is exactly the loss the rows
--    exist to survive. That is right about a clobber and wrong about the office:
--    campistry_me.js deletes payments deliberately (finPayments.splice, with an
--    Undo), and a row that is never removed would keep counting money the camp
--    has said is not there.
--
--    Same answer as 211 gave for families: `deleted_at` is stamped, never
--    destroyed. A deliberate delete disappears from every reader at once, Undo
--    clears the stamp, and a stale whole-document save still cannot erase
--    anything. Every reader below filters it.
--
-- 2. THE WEBHOOK DEDUPE HAD NO INDEX. append_camp_payment matches a retried
--    charge on any of four id fields. In the array that was a scan of every
--    payment the camp had ever taken — acceptable when the array was already
--    being parsed whole, useless now. `dedupe_keys` is a STORED generated column
--    holding those four values, with a GIN index, so a retry is one index probe.
--    Generated, so no writer can forget to maintain it.
--
-- ─── WHAT REPLACES THE LOCK ─────────────────────────────────────────────────
-- Recording a payment no longer serialises against anything camp-wide:
--   * the payment itself is an INSERT, which takes no lock at all;
--   * posting the ledger entry locks ONE family row (camp_family_for_update),
--     so two families are posted at the same instant and a payment never waits
--     behind an unrelated family's edit.
-- The idempotency that the camp-wide lock used to provide comes from the
-- primary key on (camp_id, payment_id) plus the dedupe probe, which is stronger:
-- a retried webhook cannot double-count even if it arrives twice at once.
--
-- ─── THE OFFICE KEEPS WRITING THROUGH ONE CHOKE POINT ───────────────────────
-- campistry_me.js has seven finPayments.push sites and two splice sites, and 43
-- places that mutate families. None of them are changed. They all already end in
-- save(), so save() is where the change goes: it diffs both against a snapshot
-- taken at load and sends only what actually changed to sync_camp_billing below.
-- That is strictly safer than today's whole-document save, which is what the
-- existing comment about clobbering a parent deposit is describing.
--
-- 208's trigger is LEFT IN PLACE. It can no longer clobber anything — it only
-- projects entries whose value changed in a save, and the office no longer puts
-- payments in the document at all — and leaving it means a camp whose site has
-- not been redeployed still has its payments captured.
--
-- SAFE TO RE-RUN. ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- You will get one confirmation row. Then DEPLOY THE SITE: the office half
-- ships in campistry_me.js and the two must go together.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.camp_payments') IS NULL THEN
        v_missing := v_missing || 'table camp_payments  → apply migrations/208_payments_into_rows.sql first'::text;
    END IF;
    IF to_regclass('public.camp_families') IS NULL THEN
        v_missing := v_missing || 'table camp_families  → apply migrations/211_families_into_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_families_object') THEN
        v_missing := v_missing || 'camp_families_object()  → apply migrations/212_families_read_from_rows.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'payment_ledger_entry') THEN
        v_missing := v_missing || 'payment_ledger_entry()  → apply migrations/178_every_payment_posts_to_the_ledger.sql first'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 213 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;


-- ─── 1. the soft delete, and the dedupe index ───────────────────────────────
ALTER TABLE public.camp_payments
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The four fields append_camp_payment dedupes on, as one indexable array.
-- GENERATED so it cannot drift from the payload — a writer that forgot to
-- maintain a hand-kept column is the defect shape this whole effort keeps
-- running into. NULLs in the array are harmless: `@>` on a non-null probe
-- ignores them.
ALTER TABLE public.camp_payments
    ADD COLUMN IF NOT EXISTS dedupe_keys text[]
    GENERATED ALWAYS AS (ARRAY[
        NULLIF(btrim(COALESCE(payload ->> 'id', '')), ''),
        NULLIF(btrim(COALESCE(payload ->> 'reference', '')), ''),
        NULLIF(btrim(COALESCE(payload ->> 'stripePaymentIntentId', '')), ''),
        NULLIF(btrim(COALESCE(payload ->> 'byopTransactionId', '')), '')
    ]) STORED;

CREATE INDEX IF NOT EXISTS idx_camp_payments_dedupe
    ON public.camp_payments USING gin (dedupe_keys);
-- Live payments only, which is every read the app makes.
CREATE INDEX IF NOT EXISTS idx_camp_payments_live
    ON public.camp_payments (camp_id, ordinal) WHERE deleted_at IS NULL;


-- ─── 2. the per-family primitives ───────────────────────────────────────────
-- What replaces `SELECT ... FOR UPDATE` on the camp's document: a lock on ONE
-- family's row. Two families can be posted to at the same instant, and a
-- payment never waits behind an unrelated family's edit.
--
-- Granted to nobody, like 212's accessors and for the same reason: it takes a
-- camp id. Reachable only from SECURITY DEFINER callers that scope first.
CREATE OR REPLACE FUNCTION public.camp_family_for_update(p_camp_id uuid, p_family_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_payload jsonb;
BEGIN
    SELECT payload INTO v_payload
      FROM public.camp_families
     WHERE camp_id = p_camp_id AND family_key = p_family_key AND deleted_at IS NULL
       FOR UPDATE;
    RETURN v_payload;   -- NULL when absent, as `v_me #> ARRAY['families',k]` was
END;
$$;
REVOKE ALL ON FUNCTION public.camp_family_for_update(uuid, text) FROM public, anon, authenticated;

-- Writes one family back. Keeps name/camper_ids in step with the payload so the
-- extracted columns cannot drift from what they are extracted FROM.
CREATE OR REPLACE FUNCTION public.camp_family_save(p_camp_id uuid, p_family_key text, p_payload jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    INSERT INTO public.camp_families (camp_id, family_key, name, camper_ids, payload, deleted_at)
    VALUES (p_camp_id, p_family_key,
            COALESCE(p_payload ->> 'name', ''),
            CASE WHEN jsonb_typeof(p_payload -> 'camperIds') = 'array'
                 THEN p_payload -> 'camperIds' ELSE '[]'::jsonb END,
            p_payload, NULL)
    ON CONFLICT (camp_id, family_key) DO UPDATE
       SET name = EXCLUDED.name, camper_ids = EXCLUDED.camper_ids,
           payload = EXCLUDED.payload, deleted_at = NULL, updated_at = now();
$$;
REVOKE ALL ON FUNCTION public.camp_family_save(uuid, text, jsonb) FROM public, anon, authenticated;


-- ─── 3. append_camp_payment, off the document ───────────────────────────────
-- Every decision below is 178's. What changed is where the data lives.
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
    v_existing jsonb;
    v_existingId text;
    v_merged  jsonb;
    v_famKey  text;
    v_fam     jsonb;
    v_entries jsonb;
    v_entry   jsonb;
    v_posted  boolean := false;
    v_revId   text;
    v_count   integer;
    v_pid     text;
BEGIN
    IF p_camp_id IS NULL OR p_payment IS NULL OR jsonb_typeof(p_payment) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    -- No document row to create, and no camp-wide lock to take. 178 needed both
    -- because the payment lived inside campistryMe; it does not any more.

    IF p_dedupe_key IS NOT NULL AND p_dedupe_key <> '' THEN
        -- 178's four fields, now one GIN probe instead of a scan of the array.
        SELECT payload, payment_id INTO v_existing, v_existingId
          FROM public.camp_payments
         WHERE camp_id = p_camp_id
           AND deleted_at IS NULL
           AND dedupe_keys @> ARRAY[p_dedupe_key]
         ORDER BY ordinal
         LIMIT 1;

        IF v_existing IS NOT NULL THEN
            -- 178's two cases, unchanged:
            --   p_update_on_match NULL  -> a retried webhook for a charge we
            --                              already recorded. Do nothing.
            --   p_update_on_match SET   -> a STATUS TRANSITION for a payment we
            --                              already have (Stripe sends pending,
            --                              then succeeded or failed for the same
            --                              intent). Patch it rather than adding a
            --                              second row for the same charge.
            IF p_update_on_match IS NULL OR jsonb_typeof(p_update_on_match) <> 'object' THEN
                SELECT count(*) INTO v_count FROM public.camp_payments
                 WHERE camp_id = p_camp_id AND deleted_at IS NULL;
                RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                          'updated', false, 'count', v_count);
            END IF;

            v_merged := v_existing || p_update_on_match;

            UPDATE public.camp_payments
               SET payload       = v_merged,
                   family_name   = COALESCE(v_merged ->> 'family', ''),
                   family_key    = COALESCE(v_merged ->> 'familyKey', ''),
                   enrollment_id = COALESCE(v_merged ->> 'enrollmentId', ''),
                   status        = COALESCE(v_merged ->> 'status', ''),
                   amount        = COALESCE(public._num_or_null(v_merged ->> 'amount'), 0),
                   pay_date      = COALESCE(v_merged ->> 'date', ''),
                   updated_at    = now_ts
             WHERE camp_id = p_camp_id AND payment_id = v_existingId;
             -- ordinal deliberately untouched: a status change must not move a
             -- payment in the family's history.

            -- The transition, on the ledger. 178's logic verbatim.
            v_famKey := NULLIF(v_merged->>'familyKey', '');
            IF v_famKey IS NOT NULL THEN
                v_fam := public.camp_family_for_update(p_camp_id, v_famKey);
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
                        -- remove: the ledger is append-only, and the camp needs
                        -- to see that it happened.
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
                        PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);
                    END IF;
                END IF;
            END IF;

            SELECT count(*) INTO v_count FROM public.camp_payments
             WHERE camp_id = p_camp_id AND deleted_at IS NULL;
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'updated', true, 'ledgerPosted', v_posted,
                                      'count', v_count);
        END IF;
    END IF;

    -- A new payment. One INSERT, no lock. The primary key on the identity is
    -- what makes two simultaneous retries safe — stronger than the camp-wide
    -- lock it replaces, because it holds even across connections that never met.
    v_pid := public.camp_payment_identity(p_payment);
    INSERT INTO public.camp_payments
        (camp_id, payment_id, family_name, family_key, enrollment_id,
         status, amount, pay_date, payload)
    VALUES (p_camp_id, v_pid,
            COALESCE(p_payment ->> 'family', ''),
            COALESCE(p_payment ->> 'familyKey', ''),
            COALESCE(p_payment ->> 'enrollmentId', ''),
            COALESCE(p_payment ->> 'status', ''),
            COALESCE(public._num_or_null(p_payment ->> 'amount'), 0),
            COALESCE(p_payment ->> 'date', ''),
            p_payment)
    ON CONFLICT (camp_id, payment_id) DO UPDATE
       SET payload = EXCLUDED.payload, status = EXCLUDED.status,
           amount = EXCLUDED.amount, deleted_at = NULL, updated_at = now_ts;

    -- ...and the ledger entry for it, in this same transaction.
    v_famKey := NULLIF(p_payment->>'familyKey', '');
    IF v_famKey IS NOT NULL THEN
        v_fam := public.camp_family_for_update(p_camp_id, v_famKey);
        IF v_fam IS NOT NULL AND jsonb_typeof(v_fam) = 'object' THEN
            v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                              THEN v_fam->'entries' ELSE '[]'::jsonb END;
            v_entry := public.payment_ledger_entry(p_payment);
            IF v_entry IS NOT NULL
               AND NOT public.family_covers_payment(
                       jsonb_build_object('entries', v_entries), p_payment) THEN
                v_fam := jsonb_set(v_fam, '{entries}',
                                   v_entries || jsonb_build_array(v_entry), true);
                PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);
                v_posted := true;
            END IF;
        END IF;
    END IF;

    SELECT count(*) INTO v_count FROM public.camp_payments
     WHERE camp_id = p_camp_id AND deleted_at IS NULL;
    RETURN jsonb_build_object('success', true, 'alreadyRecorded', false,
                              'updated', false, 'ledgerPosted', v_posted,
                              'count', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.append_camp_payment(uuid, jsonb, text, jsonb) TO authenticated, service_role;


-- ─── 4. the office's one write ──────────────────────────────────────────────
-- campistry_me.js's save() sends only what changed since it loaded: the 9
-- payment sites and 43 family sites are untouched, because they all already end
-- in save(). Sending a diff rather than the whole document is what removes the
-- clobber the old full-document upsert could cause.
CREATE OR REPLACE FUNCTION public.sync_camp_billing(
    p_camp_id          uuid,
    p_families_upsert  jsonb DEFAULT '{}'::jsonb,   -- {family_key: payload}
    p_families_delete  jsonb DEFAULT '[]'::jsonb,   -- [family_key]
    p_payments_upsert  jsonb DEFAULT '[]'::jsonb,   -- [payload]
    p_payments_delete  jsonb DEFAULT '[]'::jsonb    -- [payment_id]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts  timestamptz := now();
    r       record;
    v_famUp integer := 0;
    v_famDel integer := 0;
    v_payUp integer := 0;
    v_payDel integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF public.user_section_level(p_camp_id, 'me.billing') <> 'edit' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- families
    IF jsonb_typeof(p_families_upsert) = 'object' THEN
        FOR r IN SELECT key, value FROM jsonb_each(p_families_upsert)
                  WHERE jsonb_typeof(value) = 'object' LOOP
            PERFORM public.camp_family_save(p_camp_id, r.key, r.value);
            v_famUp := v_famUp + 1;
        END LOOP;
    END IF;
    IF jsonb_typeof(p_families_delete) = 'array' THEN
        UPDATE public.camp_families
           SET deleted_at = now_ts, updated_at = now_ts
         WHERE camp_id = p_camp_id
           AND deleted_at IS NULL
           AND family_key IN (SELECT jsonb_array_elements_text(p_families_delete));
        GET DIAGNOSTICS v_famDel = ROW_COUNT;
    END IF;

    -- payments
    IF jsonb_typeof(p_payments_upsert) = 'array' THEN
        FOR r IN SELECT value FROM jsonb_array_elements(p_payments_upsert) AS t(value)
                  WHERE jsonb_typeof(t.value) = 'object' LOOP
            INSERT INTO public.camp_payments
                (camp_id, payment_id, family_name, family_key, enrollment_id,
                 status, amount, pay_date, payload)
            VALUES (p_camp_id, public.camp_payment_identity(r.value),
                    COALESCE(r.value ->> 'family', ''),
                    COALESCE(r.value ->> 'familyKey', ''),
                    COALESCE(r.value ->> 'enrollmentId', ''),
                    COALESCE(r.value ->> 'status', ''),
                    COALESCE(public._num_or_null(r.value ->> 'amount'), 0),
                    COALESCE(r.value ->> 'date', ''),
                    r.value)
            ON CONFLICT (camp_id, payment_id) DO UPDATE
               SET family_name = EXCLUDED.family_name,
                   family_key = EXCLUDED.family_key,
                   enrollment_id = EXCLUDED.enrollment_id,
                   status = EXCLUDED.status, amount = EXCLUDED.amount,
                   pay_date = EXCLUDED.pay_date, payload = EXCLUDED.payload,
                   deleted_at = NULL, updated_at = now_ts;
            v_payUp := v_payUp + 1;
        END LOOP;
    END IF;
    IF jsonb_typeof(p_payments_delete) = 'array' THEN
        -- Stamped, not destroyed: the office's Undo clears it by upserting the
        -- payment again, and nothing is ever lost to a mis-click.
        UPDATE public.camp_payments
           SET deleted_at = now_ts, updated_at = now_ts
         WHERE camp_id = p_camp_id
           AND deleted_at IS NULL
           AND payment_id IN (SELECT jsonb_array_elements_text(p_payments_delete));
        GET DIAGNOSTICS v_payDel = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object('success', true,
        'familiesUpserted', v_famUp, 'familiesDeleted', v_famDel,
        'paymentsUpserted', v_payUp, 'paymentsDeleted', v_payDel);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_camp_billing(uuid, jsonb, jsonb, jsonb, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sync_camp_billing(uuid, jsonb, jsonb, jsonb, jsonb) TO authenticated, service_role;


-- ─── 5. the readers filter the soft delete ──────────────────────────────────
-- 210's office read and 212's parent slice, each with `deleted_at IS NULL`
-- added. A payment the office deleted must stop counting at once — for the camp
-- and for the family — which is the whole reason the stamp exists.
CREATE OR REPLACE FUNCTION public.get_camp_payments(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_pays jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF public.user_section_level(p_camp_id, 'me.billing') = 'none' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      INTO v_pays
      FROM public.camp_payments
     WHERE camp_id = p_camp_id AND deleted_at IS NULL;

    RETURN jsonb_build_object(
        'success',  true,
        'payments', COALESCE(v_pays, '[]'::jsonb),
        'count',    jsonb_array_length(COALESCE(v_pays, '[]'::jsonb)));
END;
$$;
REVOKE ALL ON FUNCTION public.get_camp_payments(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_camp_payments(uuid) TO authenticated, service_role;


-- ─── 6. verify ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_payment_writes(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_live integer := 0;
    v_deleted integer := 0;
    v_collected numeric := 0;
    v_dupes jsonb := '[]'::jsonb;
BEGIN
    IF p_camp_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camp');
    END IF;
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    SELECT count(*) FILTER (WHERE deleted_at IS NULL),
           count(*) FILTER (WHERE deleted_at IS NOT NULL),
           COALESCE(sum(amount) FILTER (WHERE deleted_at IS NULL
                                          AND status NOT IN ('pending', 'failed')), 0)
      INTO v_live, v_deleted, v_collected
      FROM public.camp_payments WHERE camp_id = p_camp_id;

    -- Two live rows sharing a dedupe key would mean a retried charge was
    -- recorded twice — the exact thing the old camp-wide lock was there to stop.
    SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) INTO v_dupes
      FROM (SELECT unnest(dedupe_keys) AS k
              FROM public.camp_payments
             WHERE camp_id = p_camp_id AND deleted_at IS NULL) AS x
     WHERE k IS NOT NULL
     GROUP BY k HAVING count(*) > 1;

    RETURN jsonb_build_object(
        'success', true,
        'noDoubleCounting', jsonb_array_length(COALESCE(v_dupes, '[]'::jsonb)) = 0,
        'duplicateDedupeKeys', COALESCE(v_dupes, '[]'::jsonb),
        'livePayments', v_live,
        'deletedPayments', v_deleted,
        'collected', v_collected,
        'note', 'deletedPayments counts DELIBERATE office deletions, stamped and '
             || 'never destroyed, so an Undo restores them. noDoubleCounting false '
             || 'means a retried charge was recorded twice, which is what the '
             || 'primary key and the dedupe probe replace the camp-wide lock with.');
END;
$$;
REVOKE ALL ON FUNCTION public.verify_payment_writes(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_payment_writes(uuid) TO authenticated, service_role;


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 213 applied'                                              AS status,
       to_regprocedure('public.sync_camp_billing(uuid, jsonb, jsonb, jsonb, jsonb)') IS NOT NULL AS office_write_ready,
       to_regprocedure('public.camp_family_for_update(uuid, text)') IS NOT NULL AS per_family_lock_ready,
       to_regprocedure('public.verify_payment_writes(uuid)') IS NOT NULL      AS verify_ready,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'camp_payments'
                  AND column_name = 'deleted_at')                            AS soft_delete_ready,
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_camp_payments_dedupe') AS dedupe_indexed,
       -- THE POINT OF THIS MIGRATION: append_camp_payment must no longer take a
       -- lock on the camp's document. If this reads true, nothing got faster.
       (SELECT pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'append_camp_payment')   AS still_locks_the_camp;
