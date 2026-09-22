-- ============================================================================
-- 233 — two money writers calling functions that do not exist
--
-- ⚠ APPLY THIS FIRST, BEFORE 234, AND BEFORE ANYTHING ELSE IN THIS CHAIN.
--   It is independent of every other file. One of the two defects charges a
--   family's card again every night.
--
-- WHAT IS BROKEN RIGHT NOW. Two functions call camp_family_for_update and
-- camp_family_save with argument counts those functions do not have:
--
--     camp_family_for_update(uuid, text)         -- 213. TWO arguments.
--     camp_family_save(uuid, text, jsonb)        -- 213. THREE arguments.
--
--     record_autopay_installment  calls camp_family_save with 4 and with 5
--     settle_shop_order           calls camp_family_for_update with 3
--                                 and camp_family_save with 4
--
-- No migration anywhere creates a field-scoped form. 214's transform rewrote
-- document path reads and writes —
--
--     v_charges := COALESCE(v_me #> ARRAY['families', v_famKey, 'charges'], …)
--     v_me      := jsonb_set(v_me, ARRAY['families', v_famKey, 'charges'], …)
--
-- — into calls that pass the path as extra arguments, and nothing created the
-- functions to receive them.
--
-- PL/pgSQL resolves a function name at the first EXECUTION of the statement
-- that calls it, not when the body is compiled. So both files applied cleanly,
-- both functions exist, and the failure waits inside a branch. This is the same
-- lesson as 221 and the same shape as 229: a transform reporting how many times
-- it substituted text.
--
-- WHAT IT COSTS, CONCRETELY.
--
-- 1. AUTOPAY CHARGES THE SAME INSTALLMENT EVERY NIGHT.
--    supabase/functions/charge-due-installments charges the card and THEN calls
--    record_autopay_installment to record the payment and mark the installment
--    paid. That RPC's patch branch raises 42883, so the whole call aborts:
--    nothing is recorded and the installment stays 'pending'. The edge function
--    logs its loudest line —
--
--        [autopay] … could not record installment (…)
--                  — A CARD WAS CHARGED AND IS NOT RECORDED
--
--    — and tomorrow's run finds the same pending installment and charges the
--    card again. The RPC's own comment says "the next night would charge it
--    again" as the thing it prevents. It has prevented nothing since 215 was
--    applied. Both branches are broken, legacy single-plan and multi-plan
--    alike, so no camp escapes it.
--
-- 2. NO SHOP ORDER CAN BE CHARGED TO A CAMP BILL. settle_shop_order's bill
--    branch raises before it writes anything, so the office gets a raw SQL
--    error and the charge never lands. 167 added that path so a sweatshirt
--    could not go unbilled; since 214 every sweatshirt has gone unbilled.
--
-- HOW IT WAS FOUND, AND WHY NOT SOONER. Nothing compared a call site's argument
-- count against the signatures the migrations define. tests/migration_call_arity.test.js
-- now does, across every migration, and it reports both of these plus nothing
-- else — so this is the whole of the class, not an example of it.
--
-- WHAT THIS FILE DOES. Redefines both functions with the same bodies and the
-- real signatures: read the whole locked payload, merge the one field, save the
-- whole payload back. Nothing else changes — same locks, same lock ORDER
-- (campistryShop -> campistrySnacks -> campistryMe, matching 122), same
-- dedupe, same refusals.
--
-- WHAT IT DOES NOT DO. It does not go looking for money that was charged twice.
-- Reconciling that is a decision about real families' cards, and there are none
-- yet.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, and it
-- touches no data — two CREATE OR REPLACEs and a check.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
-- The signatures this file writes calls to. If these are absent the fix would
-- silently install the same defect with different numbers.
DO $$
BEGIN
    IF to_regprocedure('public.camp_family_for_update(uuid,text)') IS NULL THEN
        RAISE EXCEPTION '233 needs camp_family_for_update(uuid,text) — apply 213 first';
    END IF;
    IF to_regprocedure('public.camp_family_save(uuid,text,jsonb)') IS NULL THEN
        RAISE EXCEPTION '233 needs camp_family_save(uuid,text,jsonb) — apply 213 first';
    END IF;
    IF to_regprocedure('public.record_autopay_installment(uuid,text,text,integer,text,jsonb,jsonb,text)') IS NULL THEN
        RAISE EXCEPTION '233 replaces record_autopay_installment — apply 169 and 215 first';
    END IF;
    IF to_regprocedure('public.settle_shop_order(uuid,text,text,numeric,boolean)') IS NULL THEN
        RAISE EXCEPTION '233 replaces settle_shop_order — apply 167, 214 and 219 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. autopay records what it charged ─────────────────────────────────────
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
            -- 233: camp_family_save takes (camp, key, WHOLE PAYLOAD). The
            -- field-scoped 4- and 5-argument forms this used to call were never
            -- created by any migration, so both branches raised 42883 and this
            -- whole RPC aborted — after the card had been charged.
            PERFORM public.camp_family_save(p_camp_id, p_family_key,
                        v_fam || jsonb_build_object('plan', v_plan));
        ELSE
            v_plans := jsonb_set(v_plans, ARRAY[v_pi::text], v_plan, true);
            PERFORM public.camp_family_save(p_camp_id, p_family_key,
                        v_fam || jsonb_build_object('plans', v_plans));
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
REVOKE ALL ON FUNCTION public.record_autopay_installment(uuid, text, text, integer, text, jsonb, jsonb, text)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_autopay_installment(uuid, text, text, integer, text, jsonb, jsonb, text)
    TO authenticated, service_role;


-- ─── 2. and a shop order can reach a camp bill ──────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_shop_order(
    p_camp_id     uuid,
    p_order_id    text,
    p_pay_method  text,
    p_total       numeric,
    p_cancelled   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_locked_acct jsonb;
    now_ts       timestamptz := now();
    v_role       text;
    v_shop       jsonb;
    v_snacks     jsonb;
    v_me         jsonb;
    v_orders     jsonb;
    v_order      jsonb := NULL;
    v_idx        integer := NULL;
    i            integer;
    v_camper     text;
    v_fam        jsonb;
    v_famKey     text := NULL;
    v_cur_method text := 'none';
    v_cur_amt    numeric := 0;
    v_new_method text;
    v_new_amt    numeric;
    v_delta      numeric;
    v_bal        numeric;
    v_charges    jsonb;
    v_kept       jsonb;
    c            jsonb;
    v_chargeId   text;
BEGIN
    IF p_camp_id IS NULL OR p_camp_id <> get_user_camp_id() THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    v_role := get_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    v_new_method := CASE WHEN p_cancelled THEN 'none' ELSE COALESCE(p_pay_method, 'none') END;
    v_new_amt    := CASE WHEN p_cancelled THEN 0 ELSE round(COALESCE(p_total, 0), 2) END;
    IF v_new_amt < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'negative_total');
    END IF;

    -- ── find the order ─────────────────────────────────────────────────────
    -- ── LOCK ORDER: campistryShop -> campistrySnacks -> campistryMe ────────
    -- Every SELECT below takes FOR UPDATE and holds it to the end of the
    -- function, because all three writes are read-modify-write on a JSONB blob.
    -- Without the lock two concurrent settlements — or a settlement racing a
    -- POS sale or a parent deposit — both read the same ledger, both append
    -- their own row, and the second write silently discards the first. The
    -- canteen balance is RECOMPUTED from that ledger, so a lost transaction is
    -- lost money, not just a lost audit line.
    --
    -- The ORDER is load-bearing and matches migration 122's place_shop_order
    -- (Shop then Snacks). Two functions taking the same two locks in opposite
    -- orders deadlock; keep any new writer on this order.
    SELECT value INTO v_shop FROM camp_state_kv
     WHERE camp_id = p_camp_id AND key = 'campistryShop'
     FOR UPDATE;
    IF v_shop IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_shop_data');
    END IF;
    v_orders := COALESCE(v_shop->'orders', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(v_orders) - 1 LOOP
        IF v_orders->i->>'id' = p_order_id THEN
            v_order := v_orders->i;
            v_idx := i;
            EXIT;
        END IF;
    END LOOP;
    IF v_order IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
    END IF;

    v_camper := COALESCE(v_order->>'camperName', '');
    IF v_order->'settlement' IS NOT NULL AND v_order->'settlement' <> 'null'::jsonb THEN
        v_cur_method := COALESCE(v_order->'settlement'->>'method', 'none');
        v_cur_amt    := round(COALESCE((v_order->'settlement'->>'amount')::numeric, 0), 2);
    END IF;

    -- Nothing to do. This is the common case on a re-save and it must be free
    -- of side effects, or every edit to an unrelated field re-posts money.
    IF v_cur_method = v_new_method AND v_cur_amt = v_new_amt THEN
        RETURN jsonb_build_object('success', true, 'unchanged', true,
                                  'method', v_cur_method, 'amount', v_cur_amt);
    END IF;

    -- Posting to the family's bill writes campistryMe, which is a billing
    -- action — a counselor running the shop must not be able to do it. The
    -- canteen path stays open to them, because taking canteen payment IS the
    -- job. (RLS is bypassed here by SECURITY DEFINER, so this check is the
    -- boundary, not a convenience.)
    IF (v_new_method = 'bill' OR v_cur_method = 'bill')
       AND v_role NOT IN ('owner', 'admin', 'manager') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized_for_billing');
    END IF;

    -- ── canteen ────────────────────────────────────────────────────────────
    IF v_cur_method = 'canteen' OR v_new_method = 'canteen' THEN
    -- 219: one camper's row, not the camp's document.
    v_snacks := NULL::jsonb;  -- document no longer read
    v_locked_acct := public.canteen_account_lock(p_camp_id, v_camper);
        IF v_snacks IS NULL THEN v_snacks := '{}'::jsonb; END IF;

        -- How much MORE to take. Same method: just the difference. Method
        -- changed away from canteen: give all of it back. Changed to canteen:
        -- take the whole new amount.
        v_delta := (CASE WHEN v_new_method = 'canteen' THEN v_new_amt ELSE 0 END)
                 - (CASE WHEN v_cur_method = 'canteen' THEN v_cur_amt ELSE 0 END);

        IF v_delta <> 0 AND v_camper <> '' THEN
            v_bal := round(COALESCE((v_locked_acct->>'balance')::numeric, 0)
                           - v_delta, 2);
    PERFORM public.canteen_account_save(p_camp_id, v_camper,
        COALESCE(v_locked_acct, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                    || jsonb_build_object('balance', v_bal));

            -- Append-only, because _reconcileBalances rebuilds every balance
            -- from this ledger. A positive delta is a debit; a negative one is
            -- money going back, which is a credit.
    PERFORM public.canteen_post(p_camp_id, v_camper,
        jsonb_build_object(
                    'time',   to_char(now_ts, 'HH12:MI AM'),
                    'camper', v_camper,
                    'items',  CASE WHEN v_delta > 0 THEN 'Camp Shop order'
                                   ELSE 'Camp Shop order — reversed' END,
                    'amount', abs(v_delta),
                    'type',   CASE WHEN v_delta > 0 THEN 'debit' ELSE 'credit' END,
                    'kind',   'shop',
                    'date',   to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp', (extract(epoch from now_ts) * 1000)::bigint
                ));

        END IF;
    END IF;

    -- ── camp bill ──────────────────────────────────────────────────────────
    IF v_cur_method = 'bill' OR v_new_method = 'bill' THEN
        SELECT value INTO v_me FROM camp_state_kv
         WHERE camp_id = p_camp_id AND key = 'campistryMe';
        IF v_me IS NULL THEN v_me := '{}'::jsonb; END IF;

        -- Whose family? Resolved here rather than trusted from the client:
        -- the camper's membership is what decides who gets billed.
        SELECT f.key INTO v_famKey
          FROM jsonb_each(public.camp_families_object(p_camp_id)) f
         WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(
                 COALESCE(f.value->'camperIds', '[]'::jsonb)) ci
              WHERE ci = v_camper)
         ORDER BY f.key
         LIMIT 1;

        IF v_famKey IS NULL AND v_new_method = 'bill' THEN
            -- No family to bill. Refuse rather than silently dropping the
            -- charge — an unbilled sweatshirt is the bug being fixed.
            RETURN jsonb_build_object('success', false, 'error', 'no_family_for_camper',
                'detail', 'No family record lists ' || v_camper ||
                          '. Add them to a family before charging the camp bill.');
        END IF;

        IF v_famKey IS NOT NULL THEN
            v_chargeId := 'shop_' || p_order_id;
            -- 233: the real signatures. camp_family_for_update takes
            -- (camp, key) and returns the whole locked payload;
            -- camp_family_save takes (camp, key, whole payload). The
            -- field-scoped 3- and 4-argument forms 214's transform wrote here
            -- were never created by any migration, so this branch raised 42883
            -- on every camp-bill settlement.
            v_fam      := public.camp_family_for_update(p_camp_id, v_famKey);
            IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN
                RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
            END IF;
            v_charges  := COALESCE(v_fam->'charges', '[]'::jsonb);

            -- Drop any previous charge for this order, then re-add at the new
            -- amount. A SET, not an append — re-settling must replace, never
            -- stack a second sweatshirt onto the family's balance.
            v_kept := '[]'::jsonb;
            FOR c IN SELECT * FROM jsonb_array_elements(v_charges) LOOP
                IF COALESCE(c->>'id', '') <> v_chargeId THEN
                    v_kept := v_kept || jsonb_build_array(c);
                END IF;
            END LOOP;

            IF v_new_method = 'bill' AND v_new_amt > 0 THEN
                v_kept := v_kept || jsonb_build_array(jsonb_build_object(
                    'id',          v_chargeId,
                    'category',    'Camp Shop',
                    'description', 'Camp Shop order' ||
                                   CASE WHEN v_camper <> '' THEN ' — ' || v_camper ELSE '' END,
                    'amount',      v_new_amt,
                    'date',        to_char(now_ts, 'YYYY-MM-DD'),
                    'shopOrderId', p_order_id,
                    'timestamp',   (extract(epoch from now_ts) * 1000)::bigint
                ));
            END IF;

            PERFORM public.camp_family_save(p_camp_id, v_famKey,
                        v_fam || jsonb_build_object('charges', v_kept));
        END IF;
    END IF;

    -- ── record what was taken ──────────────────────────────────────────────
    v_order := v_order || jsonb_build_object(
        'settlement', jsonb_build_object(
            'method',   v_new_method,
            'amount',   v_new_amt,
            'familyKey', v_famKey,
            'at',       to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        -- 'paid' means the money is actually in. Cash/cheque/card are collected
        -- outside Campistry, so the office ticks those by hand; the two methods
        -- this function settles are paid by definition once posted.
        'paid', CASE WHEN v_new_method IN ('canteen', 'bill') THEN true
                     ELSE COALESCE((v_order->>'paid')::boolean, false) END
    );

    v_shop := jsonb_set(v_shop, ARRAY['orders', v_idx::text], v_order, true);
    UPDATE camp_state_kv SET value = v_shop, updated_at = now_ts
     WHERE camp_id = p_camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object('success', true,
        'method', v_new_method, 'amount', v_new_amt,
        'previousMethod', v_cur_method, 'previousAmount', v_cur_amt,
        'familyKey', v_famKey, 'balance', v_bal);
END;
$$;
REVOKE ALL ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean)
    TO authenticated;


-- ─── 3. and no writer anywhere is left calling a shape that does not exist ──
-- The catalog cannot answer this — a call site's argument count is inside a
-- function body, as text. So this asks the only question it can ask there: do
-- these two bodies still contain a call with the wrong arity. The general sweep
-- across every migration lives in tests/migration_call_arity.test.js, which is
-- where a new one would be caught.
DO $$
DECLARE
    v_bad text;
BEGIN
    -- Matched on the SHAPE of the broken call, not on a count. A regex cannot
    -- count arguments: [^)]* crosses an opening parenthesis, so
    --     camp_family_save\s*\([^)]*,[^)]*,[^)]*,
    -- reads the comma inside jsonb_build_object('charges', v_kept) as a fourth
    -- argument and fires on the CORRECT call. The first version of this file did
    -- exactly that and refused to apply its own fix.
    --
    -- What the broken form always looked like is a QUOTED FIELD NAME in third
    -- position — 'charges', 'plan', 'plans' — which is precise and cannot match
    -- a payload expression.
    SELECT string_agg(DISTINCT p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND (p.prosrc ~ $re$camp_family_save\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$
            OR p.prosrc ~ $re$camp_family_for_update\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'still passing a field name to a family helper: %', v_bad;
    END IF;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- Both functions exist with one overload each, and neither body carries an
-- over-long call any more.
SELECT 'migration 233 applied' AS status,
       jsonb_build_object(
         'record_autopay_installment',
             (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'record_autopay_installment'),
         'settle_shop_order',
             (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'settle_shop_order'),
         'bodies_passing_a_field_name_to_a_family_helper',
             (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.prokind = 'f'
                 AND (p.prosrc ~ $re$camp_family_save\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$
                      OR p.prosrc ~ $re$camp_family_for_update\s*\(\s*[a-z_]+\s*,\s*[a-z_]+\s*,\s*'$re$))
       ) AS overloads;
