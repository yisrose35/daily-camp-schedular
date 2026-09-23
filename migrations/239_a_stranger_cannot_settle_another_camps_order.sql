-- ============================================================================
-- Migration 239: a stranger cannot settle another camp's shop order.
--
-- ⚠ APPLY THIS ONE FIRST, before 240.
--
-- THE DEFECT. settle_shop_order opens with what looks like a camp gate:
--
--     IF p_camp_id IS NULL OR p_camp_id <> get_user_camp_id() THEN
--         RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
--
-- For a caller who belongs to no camp, get_user_camp_id() returns NULL.
-- `p_camp_id <> NULL` is NULL, not true; `false OR NULL` is NULL; and `IF NULL
-- THEN` does not fire. Execution continues. The next check is
--
--     v_role := get_user_role();
--     IF v_role IS NULL THEN ... not_authorized
--
-- and get_user_role() ends in `COALESCE(..., 'viewer')`, so it is never NULL. The
-- camp-bill branch further down does test the role against
-- ('owner','admin','manager') and refuses — but the CANTEEN branch has no role
-- test of its own, because the camp gate above was supposed to have settled it.
--
-- WHAT IT COSTS. The function is granted to `authenticated`, which includes every
-- parent with a portal login. Given a camp id and the id of an order in that
-- camp's campistryShop, a stranger could debit a camper's canteen balance. Camp
-- ids travel in invite links and page URLs.
--
-- Reproduced against a real Postgres before writing this: a user owning no camp
-- and a member of none called settle_shop_order with another camp's id and took
-- $7.00 off Kid A's balance, and the function returned success.
--
-- HOW IT WAS FOUND. Writing 240's gate. Its first draft copied this same
-- comparison, and asking "what does this do when the caller has no camp" is what
-- surfaced it. The whole file is the shape this chain keeps meeting: a guard that
-- looks like a guard and bounds nothing.
--
-- WHOSE IT IS. 167 wrote the line; 214, 219, 233 and 234 each re-created the
-- function and carried it forward unchanged. So it has been open since 167.
--
-- WHAT THIS FILE DOES. Re-creates settle_shop_order with 234's body byte for
-- byte, changing the gate only: IS DISTINCT FROM instead of <>, and
-- camp_staff_member beside it — a check that does not depend on the resolver, so
-- membership is required even if get_user_camp_id ever answers NULL again.
--
-- IT IS THE ONLY FUNCTION WITH THIS SHAPE. Every other `<> get_user_camp_id()` in
-- migrations/ is inside settle_shop_order's own earlier definitions. The RLS
-- policies that compare `camp_id = get_user_camp_id()` are safe: in a policy NULL
-- is falsy, so a NULL resolver returns no rows.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, touches
-- no data — one CREATE OR REPLACE, the grants it already had, and a check.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $preflight$
BEGIN
    IF to_regprocedure('public.settle_shop_order(uuid,text,text,numeric,boolean)') IS NULL THEN
        RAISE EXCEPTION '239 replaces settle_shop_order — apply 167, 214, 219, 233 and 234 first';
    END IF;
    IF to_regprocedure('public.camp_staff_member(uuid)') IS NULL THEN
        RAISE EXCEPTION '239 needs camp_staff_member(uuid) — apply 183 first';
    END IF;
END $preflight$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. a function body with its comments taken off ─────────────────────────
-- prosrc INCLUDES COMMENTS. Four checks in this chain have now read prose as
-- code — 231's campistrySnacks check matched its own comment, and the first draft
-- of this file's verifier reported the old unsafe comparison as still present
-- because the comment below QUOTES it. So there is one named place to strip them.
--
-- Line comments only. A `--` inside a string literal would be stripped too; no
-- body this is used on contains one, and the alternative is a SQL parser.
CREATE OR REPLACE FUNCTION public._prosrc_code(p_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
    SELECT regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = p_name
     LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public._prosrc_code(text) FROM public, anon;


-- ─── 2. the same function, with a gate that holds ───────────────────────────
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
    v_orders     jsonb;
    v_order      jsonb := NULL;
    v_idx        integer := NULL;
    i            integer;
    v_camper     text;
    v_camper_id  bigint;
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
    -- ★ THE GATE, AND WHY IT IS THREE CONDITIONS AND NOT ONE.
    --
    -- This line used to read `p_camp_id IS NULL OR p_camp_id <> get_user_camp_id()`.
    -- For a caller who belongs to NO camp, get_user_camp_id() returns NULL, so
    -- `p_camp_id <> NULL` is NULL, `false OR NULL` is NULL, and `IF NULL THEN` does
    -- not fire. The function carried on. get_user_role() then answered 'viewer'
    -- (its own COALESCE default, never NULL), so the second check passed too, and
    -- the canteen branch below has no role list of its own.
    --
    -- Reproduced against a real Postgres: a signed-in user who owns nothing and is
    -- a member of nothing called settle_shop_order with another camp's id and an
    -- order id from that camp, and took $7 off a camper's canteen balance.
    --
    -- IS DISTINCT FROM closes it. camp_staff_member sits BESIDE it rather than
    -- instead of it, because it does not depend on the resolver at all: it asks
    -- whether this caller owns the camp or holds an accepted camp_users row. Every
    -- branch of get_user_camp_id already implies one of those, so no legitimate
    -- caller is newly refused — and if the resolver ever returns NULL again,
    -- membership is still required.
    IF p_camp_id IS NULL
       OR p_camp_id IS DISTINCT FROM get_user_camp_id()
       OR NOT camp_staff_member(p_camp_id) THEN
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
    -- function, because the shop write is read-modify-write on a JSONB blob.
    -- Without the lock two concurrent settlements — or a settlement racing a
    -- POS sale — both read the same document and the second write silently
    -- discards the first.
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
    -- 233: WHO, not what they were called. 230 stamps camperId on every order
    -- it writes; an order placed before that carries only a name, so resolve it
    -- the same way everything else does and accept NULL when it cannot be
    -- resolved — the name paths below still answer for those.
    v_camper_id := NULLIF(v_order->>'camperId', '')::bigint;
    IF v_camper_id IS NULL AND v_camper <> '' THEN
        v_camper_id := public.camp_person_by_name(p_camp_id, v_camper);
    END IF;

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

    -- Posting to the family's bill is a billing action — a counselor running the
    -- shop must not be able to do it. The canteen path stays open to them,
    -- because taking canteen payment IS the job. (RLS is bypassed here by
    -- SECURITY DEFINER, so this check is the boundary, not a convenience.)
    IF (v_new_method = 'bill' OR v_cur_method = 'bill')
       AND v_role NOT IN ('owner', 'admin', 'manager') THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized_for_billing');
    END IF;

    -- ── canteen ────────────────────────────────────────────────────────────
    IF v_cur_method = 'canteen' OR v_new_method = 'canteen' THEN
        -- One camper's row, not the camp's document (219). The dead
        -- `v_snacks := NULL::jsonb` the transform left here, and the
        -- `IF v_snacks IS NULL` that followed it, are gone: assigning a variable
        -- nothing reads and then testing it is the exact shape that made four
        -- other canteen writers fail on every call for months.
        v_locked_acct := public.canteen_account_lock(p_camp_id, v_camper);

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
        -- 233: the shared rule, on the id first. This is the line that used to
        -- be `WHERE ci = v_camper` and answered no_family_for_camper for a child
        -- who was in a family under the spelling they were enrolled with.
        v_famKey := public.camp_family_key_for_person(p_camp_id, v_camper_id, v_camper);

        IF v_famKey IS NULL AND v_new_method = 'bill' THEN
            -- Still refuse — 167 added this so a sweatshirt could not go
            -- unbilled — but now it means what it says: no family lists this
            -- child under any spelling, and no family holds their id.
            RETURN jsonb_build_object('success', false, 'error', 'no_family_for_camper',
                'detail', 'No family record lists ' || v_camper ||
                          '. Add them to a family before charging the camp bill.',
                'camperId', v_camper_id);
        END IF;

        IF v_famKey IS NOT NULL THEN
            v_chargeId := 'shop_' || p_order_id;
            -- The real signatures — see 233. camp_family_for_update takes
            -- (camp, key) and returns the whole locked payload; the field-scoped
            -- 3-argument form 214's transform wrote here was never created.
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
        -- The id this settlement was decided on, so a later re-settle or a
        -- dispute does not have to re-derive it from a name that may have moved
        -- on again.
        'camperId', COALESCE(to_jsonb(v_camper_id), v_order->'camperId'),
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
        'familyKey', v_famKey, 'camperId', v_camper_id, 'balance', v_bal);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.settle_shop_order(uuid, text, text, numeric, boolean)
    TO authenticated;


-- ─── 3. did it take ─────────────────────────────────────────────────────────
-- Both halves, because either alone would leave the hole reachable. Read through
-- _prosrc_code, so the comment above that quotes the old comparison is not
-- mistaken for the comparison.
DO $check$
DECLARE v_src text;
BEGIN
    v_src := public._prosrc_code('settle_shop_order');

    IF v_src IS NULL THEN
        RAISE EXCEPTION '239 did not take: settle_shop_order is gone';
    END IF;
    IF v_src !~ 'IS DISTINCT FROM get_user_camp_id' THEN
        RAISE EXCEPTION '239 did not take: the camp comparison is not NULL-safe';
    END IF;
    IF v_src !~ 'NOT camp_staff_member' THEN
        RAISE EXCEPTION '239 did not take: membership is not required beside the resolver';
    END IF;
END $check$;


-- ─── 4. the verifier ────────────────────────────────────────────────────────
-- Answers the one question this file raises, about the DEPLOYED function rather
-- than about any camp's data: is the gate NULL-safe, and is membership required.
CREATE OR REPLACE FUNCTION public.verify_shop_settlement_gate()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
    SELECT jsonb_build_object(
        'gate_is_null_safe',
            COALESCE(public._prosrc_code('settle_shop_order') ~ 'IS DISTINCT FROM get_user_camp_id', false),
        'membership_required',
            COALESCE(public._prosrc_code('settle_shop_order') ~ 'NOT camp_staff_member', false),
        -- The old shape, which must be gone. A camp that pastes an older file over
        -- this one would reopen the hole silently, and this is how that shows up.
        -- Through _prosrc_code, or the prose two screens up would answer for it.
        'old_unsafe_comparison_present',
            COALESCE(public._prosrc_code('settle_shop_order') ~ '<> get_user_camp_id', false)
    )
$fn$;

REVOKE ALL ON FUNCTION public.verify_shop_settlement_gate() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_shop_settlement_gate() TO authenticated, service_role;
