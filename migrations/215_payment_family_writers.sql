-- ════════════════════════════════════════════════════════════════════════════
-- 215 — the last seven writers: payments AND families, off the camp lock
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHERE WE ARE.
--   208 ✓ payments → rows        210 ✓ payment readers → rows
--   211 ✓ families → rows        212 ✓ family readers → rows
--   213 ✓ append_camp_payment    (still_locks_the_camp false, noDoubleCounting true)
--   214 ✓ eleven family writers  (11/11 on rows, locked_on_campistryme 0)
--   215   (here) the last seven, which touch BOTH
--   next  the load test grows a payments phase, so this is measured
--
-- After this paste, NOTHING takes SELECT ... FOR UPDATE on
-- camp_state_kv(campistryMe). That is what the confirmation row checks, across
-- the whole schema rather than just these seven.
--
-- ─── TWO NEW ACCESSORS ──────────────────────────────────────────────────────
-- camp_payments_array(camp) gives the live payments in their original order, in
-- the shape the finance.payments array had, for the three functions that only
-- READ it. camp_payment_add(camp, payload) inserts one, for the three that
-- appended one. Both granted to NOBODY — they take a camp id, so a grant to
-- `authenticated` is a cross-camp read or write. Reachable only from SECURITY
-- DEFINER callers that scope first, exactly like 212's and 213's primitives.
--
-- ─── FIVE BY RULE, TWO BY HAND, AND WHY ─────────────────────────────────────
-- scripts/transform_family_writers.py transformed five of these, and
-- tests/payment_family_writers.test.js diffs each against the migration that
-- last defined it, failing on any line no rule explains — the same discipline
-- 214 used, after the rules had already caught four bugs of their own.
--
-- TWO ARE WRITTEN OUT instead, because neither is a line-for-line substitution
-- and pretending otherwise would put a rule's authority behind a guess:
--
--   record_chargeback    walked the array to find the FIRST element matching any
--                        of four id fields and annotated it. That is a targeted
--                        single-row UPDATE against 213's dedupe_keys GIN index —
--                        `dedupe_keys && p_refs` is the same four-way test, and
--                        `ORDER BY ordinal LIMIT 1` is the same "first one".
--   set_my_payment_plan  made TWO nested mutations on the families accumulator
--                        before one branch write: set [key,'plans'] AND remove
--                        the legacy [key,'plan']. A rule matching only the first
--                        would have silently left the legacy key behind, which
--                        is a plan the parent can still be charged on.
--
-- Both have behaviour tests of their own against a real Postgres, which is where
-- their proof comes from rather than from a diff.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only; reads nothing, writes nothing.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- The confirmation row must read campistryme_locks_left = 0.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text[] := ARRAY[]::text[];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_family_for_update') THEN
        v_missing := v_missing || 'camp_family_for_update()  → apply migrations/213_payments_row_truth.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'camp_payments'
                      AND column_name = 'dedupe_keys') THEN
        v_missing := v_missing || 'camp_payments.dedupe_keys  → apply migrations/213_payments_row_truth.sql first'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'camp_families_object') THEN
        v_missing := v_missing || 'camp_families_object()  → apply migrations/212_families_read_from_rows.sql first'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION 'migration 215 cannot be applied yet. Missing: %',
            array_to_string(v_missing, '; ');
    END IF;
END
$$;


-- ─── 1. the two accessors ───────────────────────────────────────────────────
-- The finance.payments array, rebuilt from live rows in its original order. A
-- soft-deleted payment is absent, which is what every reader means by "the camp
-- deleted that".
CREATE OR REPLACE FUNCTION public.camp_payments_array(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal), '[]'::jsonb)
      FROM public.camp_payments
     WHERE camp_id = p_camp_id AND deleted_at IS NULL;
$$;
-- Granted to NOBODY: it takes a camp id, so any grant is a cross-camp read.
REVOKE ALL ON FUNCTION public.camp_payments_array(uuid) FROM public, anon, authenticated;

-- One payment in. Replaces `v_pays || jsonb_build_array(X)`; the primary key on
-- the identity is what makes a repeat safe, and a payment the office had deleted
-- comes back rather than being refused as a duplicate.
CREATE OR REPLACE FUNCTION public.camp_payment_add(p_camp_id uuid, p_payment jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    INSERT INTO public.camp_payments
        (camp_id, payment_id, family_name, family_key, enrollment_id,
         status, amount, pay_date, payload)
    VALUES (p_camp_id, public.camp_payment_identity(p_payment),
            COALESCE(p_payment ->> 'family', ''),
            COALESCE(p_payment ->> 'familyKey', ''),
            COALESCE(p_payment ->> 'enrollmentId', ''),
            COALESCE(p_payment ->> 'status', ''),
            COALESCE(public._num_or_null(p_payment ->> 'amount'), 0),
            COALESCE(p_payment ->> 'date', ''),
            p_payment)
    ON CONFLICT (camp_id, payment_id) DO UPDATE
       SET family_name = EXCLUDED.family_name, family_key = EXCLUDED.family_key,
           enrollment_id = EXCLUDED.enrollment_id, status = EXCLUDED.status,
           amount = EXCLUDED.amount, pay_date = EXCLUDED.pay_date,
           payload = EXCLUDED.payload, deleted_at = NULL, updated_at = now();
$$;
REVOKE ALL ON FUNCTION public.camp_payment_add(uuid, jsonb) FROM public, anon, authenticated;

-- ─── 2. record_autopay_charge (172) — by rule: R1, R3, R4, P1, P2, P3, R5
CREATE OR REPLACE FUNCTION public.record_autopay_charge(
    p_camp_id     uuid,
    p_family_key  text,
    p_plan_id     text,
    p_index       integer,
    p_due_date    text,
    p_amount      numeric,
    p_reason      text    DEFAULT NULL,   -- set when nothing was charged
    p_payment     jsonb   DEFAULT NULL,   -- the finance.payments row, for Billing
    p_dedupe_key  text    DEFAULT NULL,
    p_entry_note  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts    timestamptz := now();
    v_me      jsonb;
    v_fam     jsonb;
    v_plans   jsonb;
    v_plan    jsonb;
    v_pi      integer := NULL;
    v_hist    jsonb;
    v_entries jsonb;
    v_fin     jsonb;
    v_pays    jsonb;
    v_dup     boolean := false;
    v_entryId text;
    i         integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    -- Locate the plan by id. Not by position: the blob is re-read under this
    -- lock, so an index captured before it can point at a different plan.
    v_plans := CASE WHEN jsonb_typeof(v_fam->'plans') = 'array'
                    THEN v_fam->'plans' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_plans) - 1, -1) LOOP
        IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
    END LOOP;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;
    v_plan := v_plans->v_pi;

    -- Already recorded? Idempotent on the instalment INDEX, which is what makes
    -- re-running a failed night safe.
    v_hist := CASE WHEN jsonb_typeof(v_plan->'history') = 'array'
                   THEN v_plan->'history' ELSE '[]'::jsonb END;
    FOR i IN 0 .. GREATEST(jsonb_array_length(v_hist) - 1, -1) LOOP
        IF (v_hist->i->>'index')::integer = p_index THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'index', p_index);
        END IF;
    END LOOP;

    -- ── the ledger entry, when money actually moved ──────────────────────
    v_entryId := NULL;
    IF COALESCE(p_amount, 0) > 0 THEN
        v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
                          THEN v_fam->'entries' ELSE '[]'::jsonb END;

        -- The same charge twice must post one entry. A processor that retries
        -- would otherwise credit the family twice over.
        IF COALESCE(p_dedupe_key, '') <> '' THEN
            SELECT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_entries) e
                 WHERE e->'source'->>'paymentId' = p_dedupe_key
                    OR e->>'id' = p_dedupe_key
            ) INTO v_dup;
        END IF;

        IF NOT v_dup THEN
            v_entryId := 'le_ap_' || COALESCE(p_plan_id, 'plan') || '_' || p_index;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', v_entryId,
                'kind', 'payment',
                'amount', ROUND(p_amount, 2),
                'reason', 'autopay',
                'date', COALESCE(p_due_date, to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(p_entry_note, 'Autopay instalment'),
                'by', 'system',
                'source', jsonb_build_object(
                    'planId', p_plan_id,
                    'instalment', p_index,
                    'paymentId', p_dedupe_key)
            ));
            v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
        END IF;
    END IF;

    -- ── the history row, and the counter ─────────────────────────────────
    -- Appended whatever happened, including charged: 0. This is what replaces
    -- "mark it paid": a record of the outcome, never a claim it was settled.
    v_hist := v_hist || jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
            'index', p_index,
            'dueDate', p_due_date,
            'charged', ROUND(COALESCE(p_amount, 0), 2),
            'at', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'reason', p_reason,
            'entryId', v_entryId,
            'paymentId', p_dedupe_key
        )));
    v_plan := jsonb_set(v_plan, '{history}', v_hist, true);
    IF p_index >= COALESCE((v_plan->>'nextIndex')::integer, 0) THEN
        v_plan := jsonb_set(v_plan, '{nextIndex}', to_jsonb(p_index + 1), true);
    END IF;
    v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
    v_fam := jsonb_set(v_fam, '{plans}', v_plans, true);

    -- ── the Billing-facing payment row ───────────────────────────────────
    -- finance.payments stays the camp's payment list (every processor webhook
    -- writes it and Billing's refund action reads it). The ledger is the
    -- balance; this is the receipt.
    IF p_payment IS NOT NULL AND jsonb_typeof(p_payment) = 'object'
       AND COALESCE(p_amount, 0) > 0 AND NOT v_dup THEN
        v_fin := COALESCE(v_me->'finance', '{}'::jsonb);
        IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
        v_pays := public.camp_payments_array(p_camp_id);
        IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;
    PERFORM public.camp_payment_add(p_camp_id, p_payment);
    END IF;

    PERFORM public.camp_family_save(p_camp_id, p_family_key, v_fam);

    RETURN jsonb_build_object('success', true, 'index', p_index,
        'charged', ROUND(COALESCE(p_amount, 0), 2),
        'entryId', v_entryId, 'alreadyRecorded', false,
        'balance', public.family_ledger_balance(v_fam));
END;
$$;


-- ─── 3. record_autopay_installment (169) — by rule: R1, R3, R4, P1, P2, P3, R5
CREATE OR REPLACE FUNCTION public.record_autopay_installment(
    p_camp_id     uuid,
    p_family_key  text,
    p_plan_id     text,
    p_plan_index  integer,
    p_due_date    text,
    p_patch       jsonb,
    p_payment     jsonb DEFAULT NULL,
    p_dedupe_key  text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts     timestamptz := now();
    v_me       jsonb;
    v_fam      jsonb;
    v_plans    jsonb;
    v_legacy   boolean := false;
    v_pi       integer := NULL;
    v_plan     jsonb;
    v_insts    jsonb;
    v_ii       integer := NULL;
    i          integer;
    v_fin      jsonb;
    v_pays     jsonb;
    v_dup      boolean := false;
    v_patched  boolean := false;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    -- A family can have MULTIPLE plans (migration 116); a pre-116 family has a
    -- single `plan` object instead. Normalise, remembering which shape it is so
    -- the write goes back to the right place.
    IF jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_plans := v_fam->'plans';
    ELSIF jsonb_typeof(v_fam->'plan') = 'object'
          AND jsonb_typeof(v_fam->'plan'->'installments') = 'array' THEN
        v_plans := jsonb_build_array(v_fam->'plan');
        v_legacy := true;
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'no_plans');
    END IF;

    -- Locate the plan: by id when it has one, else by the position the caller
    -- saw. Re-resolved here rather than trusted, because the blob may have
    -- changed between the caller's read and this lock.
    IF COALESCE(p_plan_id, '') <> '' THEN
        FOR i IN 0 .. jsonb_array_length(v_plans) - 1 LOOP
            IF v_plans->i->>'id' = p_plan_id THEN v_pi := i; EXIT; END IF;
        END LOOP;
    END IF;
    IF v_pi IS NULL AND p_plan_index IS NOT NULL
       AND p_plan_index >= 0 AND p_plan_index < jsonb_array_length(v_plans) THEN
        v_pi := p_plan_index;
    END IF;
    IF v_pi IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_not_found');
    END IF;

    v_plan  := v_plans->v_pi;
    v_insts := COALESCE(v_plan->'installments', '[]'::jsonb);

    -- The first installment on that due date that is STILL PENDING. Once it is
    -- paid, a re-run matches nothing — which is what makes re-running a failed
    -- run safe instead of charging the family a second time.
    FOR i IN 0 .. jsonb_array_length(v_insts) - 1 LOOP
        IF v_insts->i->>'dueDate' = p_due_date
           AND COALESCE(v_insts->i->>'status', 'pending') = 'pending' THEN
            v_ii := i; EXIT;
        END IF;
    END LOOP;

    IF v_ii IS NOT NULL AND p_patch IS NOT NULL AND jsonb_typeof(p_patch) = 'object' THEN
        v_insts := jsonb_set(v_insts, ARRAY[v_ii::text], (v_insts->v_ii) || p_patch, true);
        v_plan  := jsonb_set(v_plan, '{installments}', v_insts, true);
        IF v_legacy THEN
            PERFORM public.camp_family_save(p_camp_id, p_family_key, 'plan', v_plan);
        ELSE
            PERFORM public.camp_family_save(p_camp_id, p_family_key, 'plans', v_pi::text, v_plan);
        END IF;
        v_patched := true;
    END IF;

    -- The payment, in the SAME transaction as the installment patch. Two calls
    -- would leave a window where the card is charged and the installment still
    -- reads 'pending', and the next night would charge it again.
    IF p_payment IS NOT NULL AND jsonb_typeof(p_payment) = 'object' THEN
        v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
        IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
        v_pays := public.camp_payments_array(p_camp_id);
        IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

        IF COALESCE(p_dedupe_key, '') <> '' THEN
            SELECT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_pays) p
                 WHERE p->>'id' = p_dedupe_key
                    OR p->>'reference' = p_dedupe_key
                    OR p->>'byopTransactionId' = p_dedupe_key
                    OR p->>'stripePaymentIntentId' = p_dedupe_key
            ) INTO v_dup;
        END IF;

        IF NOT v_dup THEN
    PERFORM public.camp_payment_add(p_camp_id, p_payment);
        END IF;
    END IF;


    RETURN jsonb_build_object('success', true,
        'patched', v_patched, 'alreadyRecorded', v_dup,
        'planIndex', v_pi, 'installmentIndex', v_ii);
END;
$$;


-- ─── 4. record_external_refund (178) — by rule: R1, R3, R2, R4, P1, P2, P3, R5
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
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_entryId := 'le_pay_' || p_refund_id;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      public.camp_families_object(p_camp_id)) LOOP
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
             public.camp_payments_array(p_camp_id)) e
     WHERE COALESCE(e->>'familyKey', '') <> ''
       AND (e->>'stripePaymentIntentId' = ANY(p_refs)
         OR e->>'reference' = ANY(p_refs)
         OR e->>'byopTransactionId' = ANY(p_refs)
         OR e->>'id' = ANY(p_refs))
     LIMIT 1;

    IF v_famKey IS NULL OR public.camp_family_for_update(p_camp_id, v_famKey) IS NULL THEN
        -- Same rule as a chargeback: never guess. A refund posted against the
        -- wrong family moves a stranger's balance.
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found',
                                  'refs', to_jsonb(p_refs));
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, v_famKey);
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
    PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);

    -- And a receipt, because a refund taken at the processor left the camp's own
    -- payment list disagreeing with its Stripe account.
    v_fin  := COALESCE(v_me->'finance', '{}'::jsonb);
    IF jsonb_typeof(v_fin) <> 'object' THEN v_fin := '{}'::jsonb; END IF;
    v_pays := public.camp_payments_array(p_camp_id);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;
    PERFORM public.camp_payment_add(p_camp_id, jsonb_build_object(
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
            'timestamp', (extract(epoch from now_ts) * 1000)::bigint));


    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'entryId', v_entryId, 'amount', ROUND(p_amount, 2),
        'balance', public.family_ledger_balance(v_fam));
END;
$$;


-- ─── 5. sync_family_ledger_payments (178) — by rule: R1, R2, R4, P1, R5
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
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_pays := public.camp_payments_array(p_camp_id);
    IF jsonb_typeof(v_pays) <> 'array' THEN v_pays := '[]'::jsonb; END IF;

    FOR famRec IN SELECT key, value FROM jsonb_each(
                      public.camp_families_object(p_camp_id)) LOOP
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
                PERFORM public.camp_family_save(p_camp_id, famRec.key, v_fam);
            END IF;
        END IF;
    END LOOP;

    IF NOT p_dry_run AND v_posted > 0 THEN
    END IF;

    RETURN jsonb_build_object('success', true, 'dryRun', p_dry_run,
        'posted', v_posted, 'families', v_fams,
        'skippedUnpostable', v_skipped, 'detail', v_report);
END;
$$;


-- ─── 6. convert_family_ledgers (171) — by rule: R1, R2, R4, P1, R5
CREATE OR REPLACE FUNCTION public.convert_family_ledgers(
    p_camp_id uuid,
    p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    now_ts     timestamptz := now();
    v_me       jsonb;
    v_fams     jsonb;
    v_enr      jsonb;
    v_sess     jsonb;
    v_pays     jsonb;
    famRec     record;
    enrRec     record;
    v_fam      jsonb;
    v_entries  jsonb;
    v_camperIds jsonb;
    v_tuition  numeric;
    v_liveT    numeric;
    v_disc     numeric;
    v_seq      integer := 0;
    v_n_fams   integer := 0;
    v_report   jsonb := '[]'::jsonb;
    v_bal      numeric;
    e          jsonb;

    v_note text := 'converted from derived state by migration 171';
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u
                        WHERE u.camp_id = p_camp_id AND u.user_id = caller
                          AND u.role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_permitted');
    END IF;

    IF p_dry_run THEN
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    ELSE
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
    END IF;
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', true, 'families', 0, 'note', 'no camp data');
    END IF;

    v_fams := public.camp_families_object(p_camp_id);
    v_enr  := COALESCE(v_me->'enrollments', '{}'::jsonb);
    v_sess := COALESCE(v_me->'sessions', '[]'::jsonb);
    v_pays := public.camp_payments_array(p_camp_id);

    FOR famRec IN SELECT key, value FROM jsonb_each(v_fams) LOOP
        v_fam := famRec.value;
        IF jsonb_typeof(v_fam) <> 'object' THEN CONTINUE; END IF;
        -- Already converted: never touch a real ledger.
        IF public.family_has_ledger(v_fam) THEN CONTINUE; END IF;

        v_entries := '[]'::jsonb;
        v_camperIds := CASE WHEN jsonb_typeof(v_fam->'camperIds') = 'array'
                            THEN v_fam->'camperIds' ELSE '[]'::jsonb END;

        -- ── tuition, one charge per live enrollment ──────────────────────
        FOR enrRec IN SELECT key, value FROM jsonb_each(v_enr) LOOP
            IF (enrRec.value->>'status') NOT IN ('enrolled', 'accepted') THEN CONTINUE; END IF;
            IF NOT (v_camperIds ? (enrRec.value->>'camperName')) THEN CONTINUE; END IF;

            v_liveT := (SELECT (s->>'tuition')::numeric
                          FROM jsonb_array_elements(v_sess) s
                         WHERE s->>'name' = enrRec.value->>'session' LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((enrRec.value->>'sessionTuition')::numeric, 0) END;
            IF v_tuition IS NULL OR v_tuition <= 0 THEN CONTINUE; END IF;

            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'charge', 'amount', ROUND(v_tuition, 2), 'reason', 'tuition',
                'date', COALESCE(enrRec.value->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', v_note, 'by', 'system',
                'source', jsonb_build_object(
                    'enrollmentId', enrRec.key,
                    'camperName', enrRec.value->>'camperName',
                    'camperId', enrRec.value->>'camperId',
                    'session', enrRec.value->>'session')
            ));

            v_disc := 0;
            IF enrRec.value->'discount' IS NOT NULL
               AND enrRec.value->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((enrRec.value->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((enrRec.value->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            IF v_disc > v_tuition THEN v_disc := v_tuition; END IF;
            IF v_disc > 0 THEN
                v_seq := v_seq + 1;
                v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                    'id', 'le_conv_' || famRec.key || '_' || v_seq,
                    'kind', 'credit', 'amount', ROUND(v_disc, 2), 'reason', 'discount',
                    'date', COALESCE(enrRec.value->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                    'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'note', v_note, 'by', 'system',
                    'source', jsonb_build_object('enrollmentId', enrRec.key)
                ));
            END IF;
        END LOOP;

        -- ── family charges and credits ────────────────────────────────────
        FOR e IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'charges') = 'array'
                          THEN v_fam->'charges' ELSE '[]'::jsonb END) LOOP
            IF COALESCE((e->>'amount')::numeric, 0) <= 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'charge', 'amount', ROUND((e->>'amount')::numeric, 2),
                'reason', 'fee',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'note', v_note), 'by', 'system',
                'source', '{}'::jsonb));
        END LOOP;

        FOR e IN SELECT * FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(v_fam->'credits') = 'array'
                          THEN v_fam->'credits' ELSE '[]'::jsonb END) LOOP
            IF COALESCE((e->>'amount')::numeric, 0) <= 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', 'credit', 'amount', ROUND((e->>'amount')::numeric, 2),
                'reason', 'goodwill',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'note', v_note), 'by', 'system',
                'source', '{}'::jsonb));
        END LOOP;

        -- ── payments, by familyKey. A refund is stored as a negative payment
        -- today, so it converts to a refund entry with a positive amount —
        -- rule 3: the sign lives in the kind.
        FOR e IN SELECT * FROM jsonb_array_elements(v_pays) LOOP
            IF COALESCE(e->>'familyKey', '') <> famRec.key THEN CONTINUE; END IF;
            IF COALESCE(e->>'status', '') IN ('pending', 'failed') THEN CONTINUE; END IF;
            IF COALESCE((e->>'amount')::numeric, 0) = 0 THEN CONTINUE; END IF;
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_conv_' || famRec.key || '_' || v_seq,
                'kind', CASE WHEN (e->>'amount')::numeric < 0 THEN 'refund' ELSE 'payment' END,
                'amount', ROUND(ABS((e->>'amount')::numeric), 2),
                'reason', 'card',
                'date', COALESCE(e->>'date', to_char(now_ts, 'YYYY-MM-DD')),
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', COALESCE(e->>'notes', v_note), 'by', 'system',
                'source', jsonb_build_object('paymentId', e->>'id')));
        END LOOP;

        -- ── bank deposits (Zelle/ACH), which never lived in the blob ──────
        -- The deposit id is carried on the entry (source.depositId, and the
        -- entry id itself). It was left empty originally, which meant a
        -- converted deposit could not be told apart from an unconverted one —
        -- so migration 178's ongoing poster would have posted it a SECOND time
        -- and credited the family twice. Conversion and ongoing posting now
        -- produce the same id for the same deposit, which is what makes "has
        -- this been posted?" have one answer.
        FOR e IN SELECT jsonb_build_object(
                     'id', d.id::text,
                     'amount', (d.amount_cents::numeric / 100),
                     'rev', d.is_reversal,
                     'date', to_char(d.created_at, 'YYYY-MM-DD')) AS j
                   FROM bank_deposits d
                  WHERE d.camp_id = p_camp_id AND d.status = 'posted'
                    AND d.family_key = famRec.key
        LOOP
            v_seq := v_seq + 1;
            v_entries := v_entries || jsonb_build_array(jsonb_build_object(
                'id', 'le_dep_' || (e->>'id'),
                'kind', CASE WHEN (e->>'rev')::boolean THEN 'refund' ELSE 'payment' END,
                'amount', ROUND(ABS((e->>'amount')::numeric), 2),
                'reason', 'zelle',
                'date', e->>'date',
                'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'note', 'bank deposit — ' || v_note, 'by', 'system',
                'source', jsonb_build_object('depositId', e->>'id')));
        END LOOP;

        IF jsonb_array_length(v_entries) = 0 THEN CONTINUE; END IF;

        v_fam := jsonb_set(v_fam, '{entries}', v_entries, true);
        v_bal := public.family_ledger_balance(v_fam);
        v_n_fams := v_n_fams + 1;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
            'famKey', famRec.key, 'name', v_fam->>'name',
            'entries', jsonb_array_length(v_entries), 'balance', v_bal));

        IF NOT p_dry_run THEN
            PERFORM public.camp_family_save(p_camp_id, famRec.key, v_fam);
        END IF;
    END LOOP;

    IF NOT p_dry_run AND v_n_fams > 0 THEN
    END IF;

    RETURN jsonb_build_object('success', true, 'dryRun', p_dry_run,
        'families', v_n_fams, 'detail', v_report);
END;
$$;


-- ─── 7. record_chargeback (177) — BY HAND, see the header
CREATE OR REPLACE FUNCTION public.record_chargeback(
    p_camp_id    uuid,
    p_dispute_id text,
    p_refs       text[],
    p_amount     numeric,
    p_reason     text DEFAULT NULL,
    p_status     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    now_ts   timestamptz := now();
    v_me     jsonb;
    v_fams   jsonb;
    famRec   record;
    v_fam    jsonb;
    v_famKey text := NULL;
    v_pays   jsonb;
    v_newP   jsonb;
    v_hit    boolean := false;
    v_entryId text;
    v_matched numeric := NULL;   -- what the matched payment says it was
    v_amount  numeric;           -- what we actually post
    p        jsonb;
    i        integer;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_dispute_id, '') = ''
       OR p_refs IS NULL OR array_length(p_refs, 1) IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'bad_arguments');
    END IF;
    -- NOTE: no amount check here any more. It cannot be made until we have
    -- found the payment, because the payment is one of the two places the
    -- amount can come from.

    SELECT value INTO v_me FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF v_me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_camp_data');
    END IF;

    v_entryId := 'le_cb_' || p_dispute_id;

    -- Find the family whose ledger or payment list carries this money. The
    -- ledger is checked first because that is the authoritative record.
    v_fams := public.camp_families_object(p_camp_id);
    FOR famRec IN SELECT key, value FROM jsonb_each(v_fams) LOOP
        IF jsonb_typeof(famRec.value) <> 'object' THEN CONTINUE; END IF;

        -- Already recorded? Idempotent on the dispute id, so a redelivered
        -- webhook cannot reverse the same money twice.
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                          THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
             WHERE e->>'id' = v_entryId
        ) THEN
            RETURN jsonb_build_object('success', true, 'alreadyRecorded', true,
                                      'familyKey', famRec.key);
        END IF;

        -- Same match as 175, but keep the entry's own amount: this payment is
        -- what was disputed, so its value is the best answer we have when the
        -- processor did not send one.
        SELECT (e->>'amount')::numeric INTO v_matched
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(famRec.value->'entries') = 'array'
                      THEN famRec.value->'entries' ELSE '[]'::jsonb END) e
         WHERE e->>'kind' = 'payment'
           AND (e->'source'->>'paymentId' = ANY(p_refs)
             OR e->>'id' = ANY(p_refs))
         LIMIT 1;
        IF FOUND THEN
            v_famKey := famRec.key;
            EXIT;
        END IF;
    END LOOP;

    -- Not in a ledger: fall back to finance.payments, which every processor
    -- webhook writes and which carries the processor's own reference.
    IF v_famKey IS NULL THEN
        -- ★ 215: from the payment ROWS. This lookup was missed on the first pass
        -- of this by-hand transformation, and every chargeback then failed to
        -- find its family — it was still reading the
        -- document's payments array, which nothing fills any more. The behaviour
        -- test is what caught it; a diff could not have, because the line was
        -- unchanged and therefore looked correct.
        --
        -- `dedupe_keys && p_refs` is the same four-field test the WHERE below
        -- spelled out, against 213's GIN index.
        SELECT payload->>'familyKey', (payload->>'amount')::numeric
          INTO v_famKey, v_matched
          FROM public.camp_payments
         WHERE camp_id = p_camp_id
           AND deleted_at IS NULL
           AND COALESCE(payload->>'familyKey', '') <> ''
           AND dedupe_keys && p_refs
         ORDER BY ordinal
         LIMIT 1;
    END IF;

    IF v_famKey IS NULL OR public.camp_family(p_camp_id, v_famKey) IS NULL THEN
        -- Do NOT guess. A chargeback posted against the wrong family is worse
        -- than one posted against none: the caller logs this loudly and a human
        -- reconciles it by hand.
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found',
                                  'refs', to_jsonb(p_refs));
    END IF;

    -- What the processor said, else what we captured. A partial chargeback is
    -- real and only the processor knows about it, so a supplied amount wins.
    v_amount := CASE WHEN COALESCE(p_amount, 0) > 0
                     THEN p_amount ELSE COALESCE(v_matched, 0) END;
    IF NOT (v_amount > 0) THEN
        -- We know WHOSE payment was disputed but not for how much. Posting a $0
        -- refund would read as "handled" while moving nothing at all.
        RETURN jsonb_build_object('success', false, 'error', 'amount_unknown',
                                  'familyKey', v_famKey, 'refs', to_jsonb(p_refs));
    END IF;

    v_fam := public.camp_family_for_update(p_camp_id, v_famKey);

    -- The refund entry. Balance goes back up; the original payment is untouched.
    v_fam := jsonb_set(v_fam, '{entries}',
        CASE WHEN jsonb_typeof(v_fam->'entries') = 'array'
             THEN v_fam->'entries' ELSE '[]'::jsonb END
        || jsonb_build_array(jsonb_build_object(
            'id', v_entryId,
            'kind', 'refund',
            'amount', ROUND(v_amount, 2),
            'reason', 'chargeback',
            'date', to_char(now_ts, 'YYYY-MM-DD'),
            'postedAt', to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note', 'Chargeback' || COALESCE(' — ' || p_reason, ''),
            'by', 'system',
            -- amountSource records WHERE the figure came from. When a camp later
            -- asks why a chargeback reads $450, "the payment it disputed" and
            -- "the processor said so" are different answers.
            'source', jsonb_build_object('disputeId', p_dispute_id,
                                         'refs', to_jsonb(p_refs),
                                         'amountSource',
                                         CASE WHEN COALESCE(p_amount, 0) > 0
                                              THEN 'processor' ELSE 'matched_payment' END))), true);
    PERFORM public.camp_family_save(p_camp_id, v_famKey, v_fam);

    -- Flag the payment row so Billing shows WHY it no longer counts. This is a
    -- display annotation on a receipt, not the balance — the balance moved via
    -- the entry above.
    -- ★ 215: the SAME annotation, on one row, by hand rather than by rule.
    --
    -- The original walked the whole array to find the FIRST element matching any
    -- of four id fields. `dedupe_keys && p_refs` is that same four-way test —
    -- dedupe_keys IS those four fields (213), and && is array overlap — and
    -- `ORDER BY ordinal LIMIT 1` is the same "first one" that v_hit enforced.
    -- One index probe instead of a scan of every payment the camp ever took.
    UPDATE public.camp_payments
       SET payload = payload || jsonb_build_object('disputed', true,
                       'disputeId', p_dispute_id,
                       'disputeStatus', COALESCE(p_status, 'open'),
                       'disputeReason', p_reason),
           updated_at = now_ts
     WHERE camp_id = p_camp_id
       AND payment_id = (SELECT payment_id FROM public.camp_payments
                          WHERE camp_id = p_camp_id
                            AND deleted_at IS NULL
                            AND dedupe_keys && p_refs
                          ORDER BY ordinal
                          LIMIT 1);


    -- Tell the CAMP. The existing platform email goes to the platform; an owner
    -- needs to know a parent's money was pulled back out of their account.
    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'chargeback', p_dispute_id,
            'A payment was charged back',
            COALESCE(v_fam->>'name', v_famKey) || ' — $' || ROUND(v_amount, 2)
              || ' was pulled back by the bank'
              || COALESCE(' (' || p_reason || ')', '')
              || '. Their balance has gone back up by that amount.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
        'entryId', v_entryId, 'paymentFlagged', v_hit,
        'amount', ROUND(v_amount, 2),
        'amountSource', CASE WHEN COALESCE(p_amount, 0) > 0
                             THEN 'processor' ELSE 'matched_payment' END,
        'balance', public.family_ledger_balance(v_fam));
END;
$$;


-- ─── 8. set_my_payment_plan (181) — BY HAND, see the header
CREATE OR REPLACE FUNCTION public.set_my_payment_plan(
    p_camp_id        uuid,
    p_enrollment_ids jsonb,   -- accepted for signature compatibility, IGNORED
    p_installments   jsonb    -- [{amount numeric, dueDate text}, ...]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_names    jsonb;
    me         jsonb;
    enr        jsonb;
    fams       jsonb;
    sess_list  jsonb;
    pays       jsonb;
    rec        record;
    famRec     record;
    e          jsonb;
    fam        jsonb;
    ch         jsonb;
    cr         jsonb;
    p          jsonb;
    v_tuition  numeric;
    v_liveT    numeric;
    v_disc     numeric;
    v_amt      numeric;
    v_status   text;
    v_family   text;
    v_enrIds   jsonb := '[]'::jsonb;
    v_billed   numeric := 0;
    v_paid     numeric := 0;
    v_credits  numeric := 0;
    v_target   numeric := 0;
    v_belongs  boolean;
    v_famKey   text := NULL;
    v_fam      jsonb := NULL;
    v_count    integer := 0;
    v_sum      numeric := 0;
    inst       jsonb;
    v_dates    jsonb := '[]'::jsonb;
    v_n        integer := 0;
    v_total    numeric := 0;
    v_famName  text;
    v_existingPlans jsonb;
    v_newPlan  jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camp_id IS NULL OR p_installments IS NULL OR jsonb_typeof(p_installments) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_payload');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND (status = 'active' OR billing_access = true)
      AND (expires_at IS NULL OR expires_at > now())
      AND camp_id = p_camp_id
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    v_names := COALESCE(inv.camper_names, '[]'::jsonb);

    SELECT value INTO me FROM camp_state_kv
    WHERE camp_id = p_camp_id AND key = 'campistryMe';
    IF me IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_not_found');
    END IF;

    IF NOT COALESCE((me #>> '{enrollSettings,allowParentPaymentPlans}')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'self_serve_not_enabled');
    END IF;

    enr       := COALESCE(me->'enrollments', '{}'::jsonb);
    fams      := public.camp_families_object(p_camp_id);
    sess_list := COALESCE(me->'sessions', '[]'::jsonb);
    pays      := public.camp_payments_array(p_camp_id);

    -- Target = this family's real outstanding balance, computed exactly
    -- like get_my_balance does (billed - paid - credits) — never a sum of
    -- specific enrollments' tuition, which would ignore prior payments,
    -- family-level charges, and credits already on the ledger.
    FOR rec IN SELECT key, value FROM jsonb_each(enr) LOOP
        e := rec.value;
        IF (v_names ? (e->>'camperName')) AND (e->>'status') IN ('enrolled', 'accepted') THEN
            v_liveT := (SELECT (s->>'tuition')::numeric FROM jsonb_array_elements(sess_list) s WHERE s->>'name' = e->>'session' LIMIT 1);
            v_tuition := CASE WHEN v_liveT IS NOT NULL AND v_liveT > 0 THEN v_liveT
                              ELSE COALESCE((e->>'sessionTuition')::numeric, 0) END;
            v_disc := 0;
            IF e->'discount' IS NOT NULL AND e->'discount' <> 'null'::jsonb THEN
                v_disc := COALESCE((e->'discount'->>'amt')::numeric, 0)
                        + ROUND(v_tuition * COALESCE((e->'discount'->>'pct')::numeric, 0) / 100);
            END IF;
            v_billed := v_billed + (v_tuition - v_disc);
            v_enrIds := v_enrIds || to_jsonb(rec.key);
        END IF;
    END LOOP;

    FOR famRec IN SELECT key, value FROM jsonb_each(fams) LOOP
        fam := famRec.value;
        v_belongs := EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(fam->'camperIds', '[]'::jsonb)) ci
            WHERE v_names ? ci
        );
        IF NOT v_belongs THEN CONTINUE; END IF;
        IF v_famKey IS NULL THEN v_famKey := famRec.key; v_fam := fam; END IF;

        FOR ch IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'charges', '[]'::jsonb)) LOOP
            v_billed := v_billed + COALESCE((ch->>'amount')::numeric, 0);
        END LOOP;
        FOR cr IN SELECT * FROM jsonb_array_elements(COALESCE(fam->'credits', '[]'::jsonb)) LOOP
            v_credits := v_credits + COALESCE((cr->>'amount')::numeric, 0);
        END LOOP;
    END LOOP;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_family_on_file');
    END IF;

    FOR p IN SELECT * FROM jsonb_array_elements(pays) LOOP
        v_family := COALESCE(p->>'family', '');
        IF (v_names ? v_family) OR (v_enrIds ? COALESCE(p->>'enrollmentId', '')) THEN
            v_amt := COALESCE((p->>'amount')::numeric, 0);
            v_status := COALESCE(p->>'status', '');
            IF v_status NOT IN ('pending', 'failed') THEN v_paid := v_paid + v_amt; END IF;
        END IF;
    END LOOP;

    v_target := v_billed - v_paid - v_credits;
    IF v_target <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'nothing_owed');
    END IF;

    -- Only one plan per family, full stop — reject if any plan already
    -- exists (per-camper or legacy whole-family), same as before.
    IF v_fam ? 'plans' AND jsonb_typeof(v_fam->'plans') = 'array' THEN
        v_existingPlans := v_fam->'plans';
    ELSIF v_fam ? 'plan' AND v_fam->'plan' <> 'null'::jsonb THEN
        v_existingPlans := jsonb_build_array(v_fam->'plan');
    ELSE
        v_existingPlans := '[]'::jsonb;
    END IF;
    IF jsonb_array_length(v_existingPlans) > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'plan_already_exists');
    END IF;

    FOR inst IN SELECT * FROM jsonb_array_elements(p_installments) LOOP
        v_amt := COALESCE((inst->>'amount')::numeric, 0);
        IF v_amt <= 0 OR (inst->>'dueDate') IS NULL OR (inst->>'dueDate') = '' THEN CONTINUE; END IF;
        v_count := v_count + 1;
        v_sum := v_sum + v_amt;
    END LOOP;
    IF v_count < 1 OR v_count > 60 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_installment_count');
    END IF;
    IF abs(v_sum - v_target) > 0.05 THEN
        RETURN jsonb_build_object('success', false, 'error', 'total_mismatch', 'expected', v_target, 'submitted', v_sum);
    END IF;

    FOR inst IN SELECT * FROM jsonb_array_elements(p_installments) ORDER BY (value->>'dueDate') LOOP
        v_amt := COALESCE((inst->>'amount')::numeric, 0);
        IF v_amt <= 0 OR (inst->>'dueDate') IS NULL OR (inst->>'dueDate') = '' THEN CONTINUE; END IF;
        v_n := v_n + 1;
        v_total := v_total + v_amt;
        -- The amount was required, and was just checked against the balance
        -- above. It is deliberately NOT stored: a frozen amount is a number
        -- that disagrees with reality later, which is the defect the derived
        -- model exists to remove. Only the date survives.
        v_dates := v_dates || jsonb_build_array(inst->>'dueDate');
    END LOOP;

    v_famName := coalesce(v_fam->>'name', v_names->>0, inv.parent_name, 'Family');
    -- The LEDGER shape (migration 172): when and how many, never how much.
    -- Field for field what BillingCore.newPlan() produces, because both are
    -- read by plan_due — which is what decides the amount, from the balance,
    -- at the moment of the charge.
    v_newPlan := jsonb_build_object(
        'id', 'plan_' || replace(gen_random_uuid()::text, '-', ''),
        'enrollmentIds', NULL,
        'dueDates', v_dates,
        'count', v_n,
        'nextIndex', 0,
        'history', '[]'::jsonb,
        'autopay', false,
        'paused', false,
        -- A snapshot of what was owed the day it was built, for display only.
        -- Never what gets charged.
        'total', round(v_total, 2),
        'createdAt', now()::text, 'source', 'parent'
    );
    -- ★ 215: BOTH mutations, on one family row, by hand rather than by rule.
    --
    -- The original set [key,'plans'] and then REMOVED the legacy [key,'plan'] on
    -- the accumulator before writing the whole branch. A rule matching only the
    -- first would have left the legacy singular 'plan' behind — a second plan the
    -- parent could still be charged on. So both are applied to the one row, in
    -- that order, and saved once.
    PERFORM public.camp_family_save(p_camp_id, v_famKey,
        jsonb_set(COALESCE(public.camp_family_for_update(p_camp_id, v_famKey), '{}'::jsonb),
                  ARRAY['plans'], jsonb_build_array(v_newPlan))
        #- ARRAY['plan']);


    INSERT INTO notifications (camp_id, source, source_id, title, body, link_target)
    VALUES (p_camp_id, 'parent_payment_plan_created', v_newPlan->>'id',
            'Family set up their own payment plan',
            v_famName || ' built a ' || v_n || '-payment plan (' || to_char(round(v_total,2), 'FM$999,999,990.00') || ' total) in Link.',
            'campistry_me.html')
    ON CONFLICT (camp_id, source, source_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'plan', v_newPlan);
END;
$$;


-- ─── the confirmation ───────────────────────────────────────────────────────
-- Asked of the WHOLE schema, not just these seven: after this, nothing anywhere
-- should hold a lock on the camp's document.
SELECT 'migration 215 applied' AS status,
       -- pg_get_functiondef THROWS on an aggregate ("array_agg is an aggregate
       -- function"), and this scans every function in the schema rather than a
       -- named list — so prokind = 'f' is load-bearing, not tidiness. Without it
       -- the paste dies on whatever aggregate happens to live in public.
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'key = ''campistryMe''[^;]*FOR UPDATE')
                                                                    AS campistryme_locks_left,
       -- THE NUMBER THAT MATTERS: a writer that still puts FAMILIES or PAYMENTS
       -- into the document, because the triggers would project that back over the
       -- rows. This must be 0.
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'UPDATE camp_state_kv[^;]*campistryMe'
           AND pg_get_functiondef(p.oid) ~ 'jsonb_set\([^;]{0,60}(ARRAY\[''families''|''\{families\}''|''\{payments\}''|''\{finance\}''|ARRAY\[''finance'')')
                                                                    AS money_writers_left,
       -- And the benign remainder, reported so a non-zero count is not alarming:
       -- accept_staff_contract, submit_postaccept_response,
       -- submit_posthire_response and set_card_fee_policy write
       -- staffApplications / enrollments / enrollSettings, branches that have NOT
       -- moved to rows. Writing them in the document is correct.
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'UPDATE camp_state_kv[^;]*campistryMe')
                                                                    AS other_branch_writers,
       to_regprocedure('public.camp_payments_array(uuid)') IS NOT NULL      AS array_accessor_ready,
       to_regprocedure('public.camp_payment_add(uuid, jsonb)') IS NOT NULL  AS add_accessor_ready,
       -- The shop and canteen locks must STILL be there; those blobs are read-
       -- modify-written and removing their lock would lose money.
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ '(campistryShop|campistrySnacks)''[^;]*FOR UPDATE')
                                                                    AS other_blob_locks_kept;
