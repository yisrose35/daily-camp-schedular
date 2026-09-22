-- ============================================================================
-- 233 — families and shop orders decided on ids
--
-- Two live defects and one promise kept.
--
-- 1. THE OFFICE CANNOT BILL A RENAMED CAMPER'S SHOP ORDER. settle_shop_order's
--    camp-bill path asks which family the camper belongs to like this:
--
--        WHERE ci = v_camper            -- ci from f.value->'camperIds'
--
--    camperIds holds NAMES despite its name, and a family's list is not
--    rewritten when the camp corrects a camper's spelling. So for a renamed
--    child the lookup finds nothing and the function refuses:
--
--        no_family_for_camper — "No family record lists <name>. Add them to a
--        family before charging the camp bill."
--
--    The refusal itself is right (167 added it so a sweatshirt could not go
--    unbilled). What is wrong is that it fires for a child who IS in a family.
--    The office is told to fix data that is already correct, and the only way
--    out is to re-type the old spelling into the family — which re-breaks the
--    roster.
--
-- 2. A RENAMED CAMPER'S PARENT LOSES THEIR ORDER HISTORY, SILENTLY.
--    get_my_shop_orders filters the camp's orders with
--
--        WHERE inv.camper_names IS NULL OR inv.camper_names ? (o->>'camperName')
--
--    Orders carry the spelling they were placed under. After a rename the
--    invite's camper_names holds one spelling and the old orders hold another,
--    so those orders vanish from the parent's history — and the call still
--    returns success with a shorter list, which is the worst way to lose data.
--    230 started stamping camperId on every new order and this reader ignores
--    it. It is also the last function in the database still testing
--    `camper_names ?` by hand, which is why the camp-wide sweep in
--    scripts/verify_identity_chain.sql does not come back empty.
--
-- 2b. AND THE ORDERS ALREADY PLACED. 230 stamps camperId going forward, so the
--    reader above works for every order written since. Orders placed before it
--    carry only a name, and this file stamps them in the one moment the old
--    spellings still resolve — section 7b. An order whose spelling had ALREADY
--    stopped resolving before this file runs cannot be attributed by anything,
--    and the backfill counts those separately instead of guessing. That number
--    is the honest cost of having shipped 230 after the renames rather than
--    before them.
--
-- 3. THE PROMISE. 231 matched a family three ways and said:
--
--        Migration 232 replaces all three with one id comparison, once
--        camp_families carries person ids of its own.
--
--    Being precise about what this delivers, because "one comparison" was
--    optimistic: camp_families now carries person_ids, stamped when the family
--    is saved and the spelling still resolves, so the id survives the rename.
--    That is the path almost every call takes. The name comparisons do not
--    disappear — they are still the only thing that works for a camper the
--    roster cannot resolve at all — but they stop being duplicated in two
--    functions and move into ONE helper, camp_family_key_for_person, with one
--    behaviour test. One rule in one place, not one comparison.
--
--    The fourth way 231 had — the name this parent's INVITE was written with —
--    needs an invite in hand, so it stays where the invite is, layered on top of
--    the helper and named as the narrow fallback it is.
--
-- WHY person_ids IS STAMPED AND NOT DERIVED. Same reason as 223: derived means
-- re-resolved on every read, and a name that has stopped resolving re-derives to
-- nothing. Stamped at save time, while the spelling was still live, the id
-- outlives the spelling. The projection already diffs the families object and
-- skips saves that did not touch it (206's lesson), so stamping costs one
-- subquery on the rows that actually changed, not a rewrite per save.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent. It adds
-- a column and an index, backfills, and rewrites four functions; it deletes
-- nothing. Apply 232 AND 233 first — 233 fixes the argument counts this file's
-- settle_shop_order inherits, and applying this without it reinstalls them.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_missing text := '';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_families') THEN
        v_missing := v_missing || 'camp_families (apply 211); ';
    END IF;
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        v_missing := v_missing || 'camp_person_by_name (apply 223); ';
    END IF;
    IF to_regprocedure('public.camp_families_object(uuid)') IS NULL THEN
        v_missing := v_missing || 'camp_families_object (apply 212); ';
    END IF;
    IF to_regprocedure('public._invite_covers_person(uuid,bigint)') IS NULL THEN
        v_missing := v_missing || '_invite_covers_person (apply 225 and 232); ';
    END IF;
    IF to_regprocedure('public.submit_shop_order(text,jsonb,text,text,text,bigint)') IS NULL THEN
        v_missing := v_missing || 'submit_shop_order with p_camper_id (apply 230); ';
    END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION '233 cannot be applied yet. Missing: %', v_missing;
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. families carry person ids ───────────────────────────────────────────
ALTER TABLE public.camp_families
    ADD COLUMN IF NOT EXISTS person_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.camp_families.person_ids IS
    'camper_ids resolved to camp_people.person_id when the family was saved. '
    'Stamped, not derived: the id outlives the spelling. See 233.';

-- jsonb_path_ops, same as idx_camp_families_campers, because the only question
-- ever asked of this column is containment: does this family hold this id.
CREATE INDEX IF NOT EXISTS idx_camp_families_person_ids
    ON public.camp_families USING gin (person_ids jsonb_path_ops);


-- ─── 2. the projection stamps them ──────────────────────────────────────────
-- Unchanged except for the one new expression and the ON CONFLICT line. The
-- diff at the top is load bearing and is left exactly as 211 wrote it: this
-- document is saved constantly for reasons that have nothing to do with money,
-- and an unconditional rewrite here is what took throughput from 84 rps to 26
-- in 206.
CREATE OR REPLACE FUNCTION public.project_camp_families()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_new jsonb;
    v_old jsonb;
BEGIN
    IF TG_OP <> 'INSERT'
       AND (NEW.value -> 'families') IS NOT DISTINCT FROM (OLD.value -> 'families') THEN
        RETURN NEW;
    END IF;

    v_new := CASE WHEN jsonb_typeof(NEW.value -> 'families') = 'object'
                  THEN NEW.value -> 'families' ELSE '{}'::jsonb END;
    v_old := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb
                  WHEN jsonb_typeof(OLD.value -> 'families') = 'object'
                  THEN OLD.value -> 'families' ELSE '{}'::jsonb END;

    INSERT INTO public.camp_families
        (camp_id, family_key, name, camper_ids, person_ids, payload, deleted_at)
    SELECT NEW.camp_id,
           n.key,
           COALESCE(n.value ->> 'name', ''),
           CASE WHEN jsonb_typeof(n.value -> 'camperIds') = 'array'
                THEN n.value -> 'camperIds' ELSE '[]'::jsonb END,
           -- 233: every camperIds entry that resolves, as ids. Nulls are dropped
           -- rather than kept positionally — unlike an invite, nothing here is
           -- positional, and a list of "who is in this family" with holes in it
           -- would make containment answer wrongly.
           COALESCE((SELECT jsonb_agg(DISTINCT pid)
                       FROM jsonb_array_elements_text(
                              CASE WHEN jsonb_typeof(n.value -> 'camperIds') = 'array'
                                   THEN n.value -> 'camperIds' ELSE '[]'::jsonb END) AS ci,
                            LATERAL (SELECT public.camp_person_by_name(NEW.camp_id, ci)) AS r(pid)
                      WHERE pid IS NOT NULL), '[]'::jsonb),
           n.value,
           NULL
      FROM jsonb_each(v_new) AS n
     WHERE jsonb_typeof(n.value) = 'object'
       AND ((v_old -> n.key) IS DISTINCT FROM n.value
            OR EXISTS (SELECT 1 FROM public.camp_families f
                        WHERE f.camp_id = NEW.camp_id AND f.family_key = n.key
                          AND f.deleted_at IS NOT NULL))
    ON CONFLICT (camp_id, family_key) DO UPDATE
       SET name       = EXCLUDED.name,
           camper_ids = EXCLUDED.camper_ids,
           -- An id once stamped is not dropped because a later save was made
           -- after the spelling stopped resolving. Union, never replace.
           person_ids = (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                           FROM jsonb_array_elements(
                                  camp_families.person_ids || EXCLUDED.person_ids) AS t(v)),
           payload    = EXCLUDED.payload,
           deleted_at = NULL,
           updated_at = now();

    UPDATE public.camp_families f
       SET deleted_at = now(), updated_at = now()
     WHERE f.camp_id = NEW.camp_id
       AND f.deleted_at IS NULL
       AND NOT (v_new ? f.family_key);

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_camp_families() FROM public, anon, authenticated;


-- ─── 3. and the families already saved get theirs ───────────────────────────
-- Only rows whose person_ids is still empty, so re-running this file is free
-- and never undoes a union the trigger has since made.
UPDATE public.camp_families f
   SET person_ids = COALESCE((SELECT jsonb_agg(DISTINCT pid)
                                FROM jsonb_array_elements_text(f.camper_ids) AS ci,
                                     LATERAL (SELECT public.camp_person_by_name(f.camp_id, ci)) AS r(pid)
                               WHERE pid IS NOT NULL), '[]'::jsonb),
       updated_at = now()
 WHERE f.person_ids = '[]'::jsonb
   AND jsonb_typeof(f.camper_ids) = 'array'
   AND jsonb_array_length(f.camper_ids) > 0;


-- ─── 4. one rule, one place ─────────────────────────────────────────────────
-- Which family holds this child. Three ordered ways, and the order is the order
-- they can be trusted in:
--
--   1. the stamped id — an index probe, and the only way that survives a rename;
--   2. the current name — the ordinary case, and the ONLY thing that works for a
--      camper the roster cannot resolve at all, which is most of them in a camp
--      that has not re-saved since 216;
--   3. any camperIds entry that resolves to this person — catches a family list
--      written under a different still-valid spelling, when the stamp is missing
--      because the row predates this file and never re-saved.
--
-- Returning the KEY and not the payload: every caller needs the key to write
-- back through camp_family_save, and handing out the payload invites a second
-- read-modify-write on data somebody else holds a lock on.
CREATE OR REPLACE FUNCTION public.camp_family_key_for_person(
    p_camp_id   uuid,
    p_person_id bigint,
    p_name      text DEFAULT NULL
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT f.family_key
      FROM public.camp_families f
     WHERE f.camp_id = p_camp_id
       AND f.deleted_at IS NULL
       AND (
            (p_person_id IS NOT NULL AND f.person_ids @> to_jsonb(p_person_id))
            OR (COALESCE(btrim(p_name), '') <> '' AND f.camper_ids ? p_name)
            OR (p_person_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(f.camper_ids) AS ci
                   WHERE public.camp_person_by_name(p_camp_id, ci) = p_person_id))
           )
     -- Deterministic when a camp has put one child in two families. Picking the
     -- lowest key is arbitrary but STABLE, which matters: a settlement that
     -- billed family A must re-settle against family A, not whichever row the
     -- planner returned first.
     ORDER BY f.family_key
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.camp_family_key_for_person(uuid, bigint, text)
    FROM public, anon, authenticated;


-- ─── 5. the office can bill a renamed camper ────────────────────────────────
-- settle_shop_order, unchanged except that it knows WHO the order was for.
-- The lock order (campistryShop -> campistrySnacks -> campistryMe) is preserved
-- exactly; 122's place_shop_order takes the same two in the same order, and two
-- writers taking them opposite ways deadlock.
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


-- ─── 6. a parent sees their own child's orders, whatever the child was called ─
-- The last function in the database testing `camper_names ?` by hand. It now
-- asks the shared gate the same question every other parent-facing function
-- asks, which means it inherits 232's bound for free: an order belonging to a
-- camper who arrived after this invite was resolved is not this parent's order
-- either.
CREATE OR REPLACE FUNCTION public.get_my_shop_orders(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_value  jsonb;
    v_part   jsonb;
    v_orders jsonb := '[]'::jsonb;
    v_any    boolean := false;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    FOR inv IN
        SELECT * FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND (p_camp_id IS NULL OR camp_id = p_camp_id)
        ORDER BY created_at DESC
    LOOP
        v_any := true;

        SELECT value INTO v_value FROM camp_state_kv
        WHERE camp_id = inv.camp_id AND key = 'campistryShop';
        IF v_value IS NULL THEN CONTINUE; END IF;

        SELECT COALESCE(jsonb_agg(o || jsonb_build_object('campId', inv.camp_id)), '[]'::jsonb)
        INTO v_part
        FROM jsonb_array_elements(COALESCE(v_value->'orders', '[]'::jsonb)) AS o
        WHERE inv.camper_names IS NULL
           -- 233: the id the order was placed under, when it has one. This is
           -- what makes a rename invisible to the parent: the order keeps the
           -- old spelling and the invite has the new one, but both carry the
           -- same id.
           OR (NULLIF(o->>'camperId', '') IS NOT NULL
               AND public._invite_covers_person(inv.id, (o->>'camperId')::bigint))
           -- An order placed before 230 carries only a name. The wrapper resolves
           -- it and routes through the same gate, so this is not a second rule —
           -- it is the same rule reached by a longer road.
           OR (NULLIF(o->>'camperId', '') IS NULL
               AND public._invite_covers_camper(inv.id, COALESCE(o->>'camperName', '')));

        v_orders := v_orders || v_part;
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    RETURN jsonb_build_object('success', true, 'orders', v_orders);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_shop_orders(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_shop_orders(uuid) TO authenticated;


-- ─── 7. the canteen's family lookup, on the shared rule ─────────────────────
-- 231 inlined three ordered comparisons here and said 232 would replace them.
-- Two of the three are now camp_family_key_for_person's job. The third — the
-- name this parent's INVITE was written with — needs the invite, so it stays,
-- explicitly, as the narrow fallback for a family list holding a spelling the
-- roster has dropped entirely.
CREATE OR REPLACE FUNCTION public.use_family_card_for_canteen_auto_reload(
    p_camp_id            uuid,
    p_camper_name        text,
    p_payment_method_id  text DEFAULT NULL,
    p_camper_id          bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_id     bigint;
    v_name   text;
    v_famKey text;
    v_fam    jsonb;
    v_pm     jsonb;
    v_picked jsonb := NULL;
    v_acct   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
      FROM link_parent_invites
     WHERE user_id = caller AND status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (p_camp_id IS NULL OR camp_id = p_camp_id)
     ORDER BY created_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    -- The shared gate decides whose child this is; this function never asks the
    -- camper question itself.
    v_id := COALESCE(p_camper_id, public.camp_person_by_name(inv.camp_id, p_camper_name));
    IF v_id IS NOT NULL THEN
        IF NOT public._invite_covers_person(inv.id, v_id) THEN
            RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
        END IF;
    ELSIF NOT public._invite_covers_camper(inv.id, p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    v_name := COALESCE(public.camp_person_label(inv.camp_id, v_id), p_camper_name);

    -- 233: two of 231's three comparisons, in one place.
    v_famKey := public.camp_family_key_for_person(inv.camp_id, v_id, v_name);

    -- The third. An invite and a family snapshot are produced by the same office
    -- sync from the same roster keys, so they are the same vintage: when
    -- camperIds holds a spelling the roster has since dropped, the invite holds
    -- it too, and 223 stamped that slot with the id. Nothing else can bridge
    -- that, which is why it is still here and why it is last.
    IF v_famKey IS NULL AND v_id IS NOT NULL
       AND jsonb_typeof(inv.camper_names) = 'array' THEN
        SELECT f.family_key INTO v_famKey
          FROM public.camp_families f
         WHERE f.camp_id = inv.camp_id AND f.deleted_at IS NULL
           AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(f.camper_ids) AS ci
                 CROSS JOIN LATERAL jsonb_array_elements(inv.camper_names)
                            WITH ORDINALITY AS e(value, ord)
                WHERE e.value #>> '{}' = ci
                  AND COALESCE(inv.person_ids -> (e.ord - 1)::int, 'null'::jsonb)
                      = to_jsonb(v_id))
         ORDER BY f.family_key
         LIMIT 1;
    END IF;

    IF v_famKey IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'family_not_found');
    END IF;

    SELECT f.payload INTO v_fam
      FROM public.camp_families f
     WHERE f.camp_id = inv.camp_id AND f.family_key = v_famKey;

    IF p_payment_method_id IS NOT NULL THEN
        FOR v_pm IN SELECT * FROM jsonb_array_elements(
                        COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb)) LOOP
            IF v_pm->>'id' = p_payment_method_id THEN v_picked := v_pm; EXIT; END IF;
        END LOOP;
    ELSE
        v_picked := (COALESCE(v_fam->'savedPaymentMethods', '[]'::jsonb))->0;
    END IF;

    IF v_picked IS NULL OR v_picked = 'null'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_saved_card');
    END IF;

    -- One camper's row, not the camp's document.
    v_acct := COALESCE(public.canteen_account_lock(inv.camp_id, v_name),
                       '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
    v_acct := jsonb_set(v_acct, '{autoReload}',
                        COALESCE(v_acct->'autoReload', '{}'::jsonb)
                        || jsonb_build_object(
                             'paymentMethodId', v_picked->>'id',
                             'last4',           v_picked->>'last4',
                             'brand',           v_picked->>'brand',
                             'source',          'family'),
                        true);
    PERFORM public.canteen_account_save(inv.camp_id, v_name, v_acct);

    RETURN jsonb_build_object('success', true, 'familyKey', v_famKey,
                              'camperId', v_id,
                              'paymentMethodId', v_picked->>'id',
                              'last4', v_picked->>'last4');
END;
$$;
REVOKE ALL ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.use_family_card_for_canteen_auto_reload(uuid, text, text, bigint)
    TO authenticated;


-- ─── 7b. the orders already placed get their id, while the name still works ──
-- 230 stamps camperId on every order it writes from here on. Every order placed
-- BEFORE it carries only a name, and a name is exactly what stops working. So
-- stamp them now, in the one moment the old spellings still resolve.
--
-- THIS IS THE ONE THING 234 CANNOT DO LATE. An order whose spelling had already
-- stopped resolving before this file ran cannot be attributed by anything —
-- not by the family, not by the invite, not by the roster. Its parent has
-- already lost it from their history and only a human who remembers the rename
-- can put it back. Everything else in this file is repair; this is the part
-- that has to happen before the next rename, not after it.
--
-- A function, not a bare UPDATE, because the header promises repair and a block
-- pasted once is not a tool anybody can reach. Idempotent: it only touches
-- orders with no camperId.
CREATE OR REPLACE FUNCTION public.backfill_shop_order_camper_ids()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r         record;
    v_orders  jsonb;
    v_out     jsonb;
    v_o       jsonb;
    v_id      bigint;
    v_stamped bigint := 0;
    v_left    bigint := 0;
BEGIN
    FOR r IN
        SELECT k.camp_id, k.value
          FROM camp_state_kv k
         WHERE k.key = 'campistryShop'
           AND jsonb_typeof(k.value -> 'orders') = 'array'
           AND jsonb_array_length(k.value -> 'orders') > 0
         FOR UPDATE
    LOOP
        v_orders := r.value -> 'orders';
        v_out    := '[]'::jsonb;
        FOR v_o IN SELECT * FROM jsonb_array_elements(v_orders) LOOP
            IF NULLIF(v_o->>'camperId', '') IS NULL
               AND COALESCE(btrim(v_o->>'camperName'), '') <> '' THEN
                v_id := public.camp_person_by_name(r.camp_id, v_o->>'camperName');
                IF v_id IS NOT NULL THEN
                    v_o := v_o || jsonb_build_object('camperId', v_id);
                    v_stamped := v_stamped + 1;
                ELSE
                    -- Recorded, not guessed. This is the count a human has to
                    -- look at; there is no rule that can resolve it.
                    v_left := v_left + 1;
                END IF;
            END IF;
            v_out := v_out || jsonb_build_array(v_o);
        END LOOP;

        -- Only write when something changed. This document is saved constantly
        -- for unrelated reasons and an unconditional rewrite here is 206's
        -- throughput lesson.
        IF v_out IS DISTINCT FROM v_orders THEN
            UPDATE camp_state_kv
               SET value = jsonb_set(r.value, '{orders}', v_out, true), updated_at = now()
             WHERE camp_id = r.camp_id AND key = 'campistryShop';
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true,
                              'orders_stamped', v_stamped,
                              'orders_whose_camper_cannot_be_resolved', v_left);
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_shop_order_camper_ids() FROM public, anon, authenticated;

SELECT public.backfill_shop_order_camper_ids();


-- ─── 8. the verifier ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_family_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fams      bigint;
    v_named     bigint;
    v_stamped   bigint;
    v_orders    bigint;
    v_with_id   bigint;
    v_unbillable bigint;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE jsonb_array_length(camper_ids) > 0),
           count(*) FILTER (WHERE jsonb_array_length(person_ids) > 0)
      INTO v_fams, v_named, v_stamped
      FROM camp_families WHERE deleted_at IS NULL;

    -- Shop orders, and how many know who they were for. 230 stamps camperId
    -- going forward; the gap is orders placed before it.
    SELECT count(*), count(*) FILTER (WHERE NULLIF(o->>'camperId', '') IS NOT NULL)
      INTO v_orders, v_with_id
      FROM camp_state_kv k
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(k.value -> 'orders') = 'array'
               THEN k.value -> 'orders' ELSE '[]'::jsonb END) AS o
     WHERE k.key = 'campistryShop';

    -- THE NUMBER THIS FILE EXISTS FOR. An order whose camper is in no family by
    -- any of the three ways — i.e. one the office genuinely cannot bill. Before
    -- 233 this counted every renamed camper as well.
    SELECT count(*)
      INTO v_unbillable
      FROM camp_state_kv k
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(k.value -> 'orders') = 'array'
               THEN k.value -> 'orders' ELSE '[]'::jsonb END) AS o
     WHERE k.key = 'campistryShop'
       AND COALESCE(o->>'camperName', '') <> ''
       AND public.camp_family_key_for_person(
             k.camp_id,
             COALESCE(NULLIF(o->>'camperId', '')::bigint,
                      public.camp_person_by_name(k.camp_id, o->>'camperName')),
             o->>'camperName') IS NULL;

    RETURN jsonb_build_object(
        'success', true,
        'live_families', v_fams,
        'families_naming_a_camper', v_named,
        'families_carrying_an_id', v_stamped,
        'shop_orders', v_orders,
        'shop_orders_carrying_a_camper_id', v_with_id,
        'orders_no_family_can_be_billed_for', v_unbillable,
        'still_matching_camper_names_by_hand',
            COALESCE((SELECT jsonb_agg(DISTINCT p.proname)
                        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.prokind = 'f'
                         AND p.prosrc ~ 'camper_names \?'), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_family_identity() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_family_identity() TO authenticated;


-- ─── 9. the assertions ──────────────────────────────────────────────────────
DO $$
DECLARE
    r     record;
    v_bad text;
BEGIN
    -- Nothing anywhere tests camper_names by hand any more. This is the
    -- camp-wide sweep that scripts/verify_identity_chain.sql has been reporting
    -- a non-empty answer for since 231, and get_my_shop_orders was the reason.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.prosrc ~ 'camper_names \?';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'still testing camper_names ? by hand: %', v_bad;
    END IF;

    -- No caller compares a family's camperIds to a bare name any more, outside
    -- the one helper that is allowed to.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname <> 'camp_family_key_for_person'
       AND p.prosrc ~ 'camperIds.*\n?.*ci = '
       AND p.proname IN ('settle_shop_order', 'use_family_card_for_canteen_auto_reload');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'still matching a family by bare name: %', v_bad;
    END IF;

    -- settle_shop_order actually reads the id 230 stamps.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'settle_shop_order'
                      AND p.prosrc ~ 'camp_family_key_for_person') THEN
        RAISE EXCEPTION 'settle_shop_order does not use the shared family rule';
    END IF;

    -- One overload each, because PostgREST resolves by argument name.
    FOR r IN
        SELECT p.proname, count(*) AS c
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('settle_shop_order', 'get_my_shop_orders',
                             'use_family_card_for_canteen_auto_reload',
                             'camp_family_key_for_person', 'verify_family_identity')
         GROUP BY p.proname
    LOOP
        IF r.c <> 1 THEN
            RAISE EXCEPTION 'public.% has % overloads — PostgREST cannot choose',
                            r.proname, r.c;
        END IF;
    END LOOP;
END $$;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- still_matching_camper_names_by_hand must be []. orders_no_family_can_be_billed_for
-- is a fact about the camp's data: an order for a child in no family at all.
SELECT 'migration 233 applied' AS status,
       public.verify_family_identity() AS family_identity;
