-- ============================================================================
-- Migration 122: a departed camper disconnects their parent from the camp's
-- LIVE features, without touching billing or photos.
--
-- Why: deleteCamper's offboarding sweep (revoke_orphaned_parent_invites,
-- migration 034) used to flip link_parent_invites.status to 'revoked' once
-- a parent's last camper left the roster. Per the owner: that's the wrong
-- shape. Revoking status locks the parent out of EVERYTHING — including
-- their own payment history and photos they already have — and separately
-- breaks their ability to even sign back in at all, since
-- get_parent_data_by_user/claim_parent_invite (migration 035) both require
-- an active-status invite with no fallback. Migration 070's whole
-- "billing_access survives offboarding" design was consequently
-- unreachable in the common case (a parent's ONLY invite going stale).
--
-- New design, reusing the exact mechanism a camp owner already has for
-- turning off a whole program camp-wide (camp_link_program_settings,
-- migration 106, folded into get_my_link_features by migration 108) — just
-- scoped to ONE parent instead of the whole camp:
--
--   * status stays 'active' forever. Login, get_my_link_features, billing
--     (get_my_balance/get_my_camps, migration 070) and photos
--     (_parent_owns_camper, get_camp_photos_browse) are UNCHANGED and keep
--     working off the same camper_names/camper_data snapshot — that
--     snapshot is never cleared and nothing new gets matched to it going
--     forward. It's frozen from the moment the camper is deleted, and
--     that's it.
--   * A new camp_connected flag (default true) flips to false once none
--     of a parent's campers remain on the roster. get_my_link_features
--     folds that into the SAME per-camp features map the client already
--     reads (campistry_link_parent.html's lkLoadFeatures/apply/guard are
--     completely data-driven over data-page keys — zero client changes
--     needed), forcing off: canteen, shop, tips, camper mail, pickup,
--     messages, schedule, forms, lists, health, emergency. payments and
--     photos are deliberately left alone.
--   * submit_shop_order/submit_camper_mail/submit_parent_message (the
--     three parent-initiated RPCs that move money or send new content) get
--     the same server-side check, matching migration 107's established
--     "a hidden button is not a real gate" rule — a departed parent can't
--     start a NEW canteen-funded order, camper mail, or message just
--     because they still have the page open from before the sweep ran.
--
-- revoke_orphaned_parent_invites keeps its exact name and signature — the
-- only caller (campistry_me.js's _autoProvisionParentInvites) needs no
-- change — but now flips camp_connected instead of status.
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE public.link_parent_invites
    ADD COLUMN IF NOT EXISTS camp_connected boolean NOT NULL DEFAULT true;

-- ─── 1. revoke_orphaned_parent_invites — disconnect, don't revoke ─────────
CREATE OR REPLACE FUNCTION public.revoke_orphaned_parent_invites(
    p_camp_id      uuid,
    p_roster_names jsonb          -- array of every camper name currently on the roster
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    n int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF NOT EXISTS (SELECT 1 FROM camps c WHERE c.id = p_camp_id AND c.owner = caller)
       AND NOT EXISTS (SELECT 1 FROM camp_users u WHERE u.camp_id = p_camp_id AND u.user_id = caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
    END IF;
    -- Safety: never mass-disconnect when we were handed an empty roster.
    IF p_roster_names IS NULL OR jsonb_typeof(p_roster_names) <> 'array' OR jsonb_array_length(p_roster_names) = 0 THEN
        RETURN jsonb_build_object('success', true, 'revoked', 0, 'skipped', 'empty_roster');
    END IF;

    WITH stale AS (
        SELECT i.id
        FROM link_parent_invites i
        WHERE i.camp_id = p_camp_id
          AND i.camp_connected = true
          AND NOT EXISTS (
              -- any camper on this invite still present in the roster?
              SELECT 1
              FROM jsonb_array_elements_text(coalesce(i.camper_names, '[]'::jsonb)) cn
              WHERE p_roster_names ? cn
          )
    )
    UPDATE link_parent_invites SET camp_connected = false
    WHERE id IN (SELECT id FROM stale);
    GET DIAGNOSTICS n = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'revoked', n);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.revoke_orphaned_parent_invites(uuid, jsonb) TO authenticated;


-- ─── 2. get_my_link_features — fold in the per-parent disconnect ──────────
CREATE OR REPLACE FUNCTION public.get_my_link_features()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_row      link_camp_features;
    v_progrow  camp_link_program_settings;
    v_union    jsonb := '{}'::jsonb;
    v_by_camp  jsonb := '{}'::jsonb;
    v_camp     jsonb;
    v_key      text;
    v_any      boolean := false;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    FOR inv IN
        SELECT * FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
    LOOP
        v_any := true;

        SELECT * INTO v_row FROM link_camp_features WHERE camp_id = inv.camp_id;
        v_camp := COALESCE(v_row.features, '{}'::jsonb);

        SELECT * INTO v_progrow FROM camp_link_program_settings WHERE camp_id = inv.camp_id;
        IF FOUND THEN
            IF v_progrow.photos_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{photos}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.canteen_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{canteen}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.shop_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{shop}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.tips_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{tips}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.camper_mail_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{mail}', 'false'::jsonb, true);
            END IF;
            IF v_progrow.pickup_enabled IS FALSE THEN
                v_camp := jsonb_set(v_camp, '{pickup}', 'false'::jsonb, true);
            END IF;
        END IF;

        -- NEW: this parent's own connection to THIS camp ended (their last
        -- camper left the roster) — everything "live with the camp" goes
        -- dark for this camp's contribution to the union below. payments
        -- and photos are deliberately excluded — those survive per the
        -- owner's explicit call, off the frozen camper_names/camper_data
        -- snapshot this invite already carries.
        IF NOT inv.camp_connected THEN
            v_camp := jsonb_set(v_camp, '{canteen}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{shop}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{tips}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{mail}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{pickup}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{messages}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{schedule}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{forms}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{lists}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{health}', 'false'::jsonb, true);
            v_camp := jsonb_set(v_camp, '{emergency}', 'false'::jsonb, true);
        END IF;

        v_by_camp := jsonb_set(v_by_camp, ARRAY[inv.camp_id::text], v_camp, true);

        -- Union: a key is only false when EVERY camp says false. Seeding the
        -- union from each camp's own map means a key nobody mentions stays
        -- absent, and absent means enabled on the client.
        FOR v_key IN SELECT jsonb_object_keys(v_camp) LOOP
            IF COALESCE((v_camp->>v_key)::boolean, true) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'true'::jsonb, true);
            ELSIF NOT (v_union ? v_key) THEN
                v_union := jsonb_set(v_union, ARRAY[v_key], 'false'::jsonb, true);
            END IF;
        END LOOP;
    END LOOP;

    IF NOT v_any THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    RETURN jsonb_build_object('success', true, 'features', v_union, 'byCamp', v_by_camp);
EXCEPTION WHEN OTHERS THEN
    -- Never let this break the portal: an error here should mean "show
    -- everything", which the client treats as the default.
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
-- Grants unchanged by CREATE OR REPLACE — still authenticated-only, per 053.


-- ─── 3. submit_shop_order — add the camp_connected check ──────────────────
-- Full original body (migration 107) plus one new check, right after the
-- existing invite/camper-ownership check and before the program-enabled
-- check — same spot, same "server-side is the real gate" rule.
CREATE OR REPLACE FUNCTION public.submit_shop_order(
    p_camper_name text,
    p_lines       jsonb,
    p_pay_method  text DEFAULT 'bill',
    p_notes       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller     uuid := auth.uid();
    inv        link_parent_invites;
    v_shop     jsonb;
    v_snacks   jsonb;
    v_line     jsonb;
    v_product  jsonb;
    v_variant  text;
    v_qty      int;
    v_unit     numeric;
    v_delta    numeric;
    v_stock    int;
    v_backorder boolean;
    v_lines    jsonb := '[]'::jsonb;
    v_total    numeric := 0;
    v_count    int := 0;
    v_balance  numeric;
    v_order_id text;
    v_bunk     text;
    now_ts     timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    IF jsonb_array_length(p_lines) > 40 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_many_lines');
    END IF;
    IF p_pay_method IS NULL OR p_pay_method NOT IN ('bill', 'canteen') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_pay_method');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;
    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- NEW: this parent's connection to the camp ended (their last camper
    -- left) — no new canteen/bill order can be started, same rule as the
    -- program-disabled check right below.
    IF NOT inv.camp_connected THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_disconnected');
    END IF;

    -- Camp-wide "does this camp even run a Camp Shop" gate. Checked after
    -- the invite/camper-ownership checks above (so those keep taking
    -- priority) and before touching campistryShop at all.
    IF NOT public._link_program_enabled(inv.camp_id, 'shop') THEN
        RETURN jsonb_build_object('success', false, 'error', 'program_disabled');
    END IF;

    -- Guarantee a row exists, then lock it. Lock order is always
    -- campistryShop -> campistrySnacks (see security note 5).
    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistryShop', '{"products":[],"orders":[],"settings":{}}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_shop
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryShop'
    FOR UPDATE;

    IF v_shop IS NULL THEN v_shop := '{"products":[],"orders":[],"settings":{}}'::jsonb; END IF;
    v_backorder := COALESCE((v_shop->'settings'->>'parentAllowBackorder')::boolean, false);

    -- ── price and validate every line from the STORED catalogue ──
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
        v_qty := GREATEST(0, COALESCE((v_line->>'qty')::int, 0));
        CONTINUE WHEN v_qty = 0;
        IF v_qty > 50 THEN
            RETURN jsonb_build_object('success', false, 'error', 'qty_too_large');
        END IF;

        v_product := NULL;   -- explicit: never inherit the previous iteration's row
        SELECT p INTO v_product
        FROM jsonb_array_elements(COALESCE(v_shop->'products', '[]'::jsonb)) AS p
        WHERE p->>'id' = v_line->>'productId'
          AND COALESCE((p->>'active')::boolean, true) IS TRUE
        LIMIT 1;

        IF v_product IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'product_unavailable',
                                      'productId', v_line->>'productId');
        END IF;

        v_variant :=
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_product->>'sku',''), v_product->>'id')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'size',''), 'onesize')), '[^a-z0-9]+', '-', 'g'), '-')
            || ':' ||
            btrim(regexp_replace(lower(COALESCE(NULLIF(v_line->>'color',''), 'default')), '[^a-z0-9]+', '-', 'g'), '-');

        v_delta := COALESCE((v_product->'priceDeltas'->>(v_line->>'size'))::numeric, 0);
        v_unit  := round(COALESCE((v_product->>'price')::numeric, 0) + v_delta, 2);

        IF NOT v_backorder THEN
            v_stock := COALESCE((v_product->'stock'->>v_variant)::int, 0);
            IF v_qty > v_stock THEN
                RETURN jsonb_build_object('success', false, 'error', 'out_of_stock',
                    'product', v_product->>'name', 'size', v_line->>'size',
                    'available', v_stock, 'wanted', v_qty);
            END IF;
        END IF;

        v_total := v_total + (v_unit * v_qty);
        v_count := v_count + v_qty;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'productId', (v_product->>'id')::int,
            'name',      v_product->>'name',
            'size',      COALESCE(v_line->>'size', ''),
            'color',     COALESCE(v_line->>'color', ''),
            'qty',       v_qty,
            'unitPrice', v_unit
        ));
    END LOOP;

    IF jsonb_array_length(v_lines) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'empty_order');
    END IF;
    v_total := round(v_total, 2);

    -- ── canteen payment: draw the total from the camper's balance ──
    IF p_pay_method = 'canteen' THEN
        INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
        VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
        ON CONFLICT (camp_id, key) DO NOTHING;

        SELECT value INTO v_snacks
        FROM camp_state_kv
        WHERE camp_id = inv.camp_id AND key = 'campistrySnacks'
        FOR UPDATE;

        IF v_snacks IS NULL THEN v_snacks := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
        v_balance := COALESCE((v_snacks->'accounts'->p_camper_name->>'balance')::numeric, 0);

        IF v_balance < v_total THEN
            RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
                                      'balance', v_balance, 'total', v_total);
        END IF;

        v_balance := round(v_balance - v_total, 2);
        v_snacks := jsonb_set(
            v_snacks, ARRAY['accounts', p_camper_name],
            COALESCE(v_snacks->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
                || jsonb_build_object('balance', v_balance),
            true
        );
        v_snacks := jsonb_set(
            v_snacks, '{transactions}',
            jsonb_build_array(jsonb_build_object(
                'time',   to_char(now_ts, 'HH12:MI AM'),
                'camper', p_camper_name,
                'items',  'Camp Shop order',
                'amount', v_total,
                'type',   'debit',
                'kind',   'shop',
                'date',   to_char(now_ts, 'YYYY-MM-DD')
            )) || COALESCE(v_snacks->'transactions', '[]'::jsonb)
        );

        UPDATE camp_state_kv
        SET value = v_snacks, updated_at = now_ts
        WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';
    END IF;

    -- Bunk, so the office's pick list groups the order without a lookup.
    SELECT value->'camperRoster'->p_camper_name->>'bunk' INTO v_bunk
    FROM camp_state_kv WHERE camp_id = inv.camp_id AND key = 'app1';

    v_order_id := 'ord_p_' || replace(gen_random_uuid()::text, '-', '');

    v_shop := jsonb_set(
        v_shop, '{orders}',
        COALESCE(v_shop->'orders', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'id',          v_order_id,
            'camperName',  p_camper_name,
            'bunk',        COALESCE(v_bunk, ''),
            'lines',       v_lines,
            'status',      'placed',
            'paid',        (p_pay_method = 'canteen'),
            'payMethod',   p_pay_method,
            'notes',       COALESCE(p_notes, ''),
            'placedAt',    to_char(now_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'source',      'parent'
        )),
        true
    );

    UPDATE camp_state_kv
    SET value = v_shop, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistryShop';

    RETURN jsonb_build_object(
        'success', true, 'orderId', v_order_id,
        'total', v_total, 'items', v_count,
        'paid', (p_pay_method = 'canteen'),
        'balance', v_balance
    );
END;
$$;


-- ─── 4. submit_camper_mail — add the camp_connected check ─────────────────
CREATE OR REPLACE FUNCTION public.submit_camper_mail(
    p_camper_name text,
    p_subject     text DEFAULT '',
    p_body        text DEFAULT '',
    p_division    text DEFAULT NULL,
    p_grade       text DEFAULT NULL,
    p_bunk        text DEFAULT NULL,
    p_camp_id     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    n_today integer;
    new_id  uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR p_camper_name = '' OR p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;
    IF length(p_body) > 20000 OR length(coalesce(p_subject, '')) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_long');
    END IF;

    IF p_camp_id IS NOT NULL AND btrim(p_camp_id) <> '' THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND camp_id = p_camp_id::uuid
        ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF inv.id IS NULL THEN
        SELECT * INTO inv FROM link_parent_invites
        WHERE user_id = caller AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC LIMIT 1;
    END IF;

    IF inv.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF inv.camper_names IS NOT NULL
       AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- NEW: this parent's connection to the camp ended — no new camper mail.
    IF NOT inv.camp_connected THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_disconnected');
    END IF;

    -- Camp-wide "does this camp run Camper Mail" gate.
    IF NOT public._link_program_enabled(inv.camp_id, 'camperMail') THEN
        RETURN jsonb_build_object('success', false, 'error', 'program_disabled');
    END IF;

    SELECT count(*) INTO n_today
    FROM link_camper_mail
    WHERE invite_id = inv.id
      AND created_at > now() - interval '24 hours';
    IF n_today >= 25 THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_reached');
    END IF;

    INSERT INTO link_camper_mail (
        camp_id, invite_id, user_id, camper_name, division, grade, bunk,
        parent_name, parent_email, subject, body
    ) VALUES (
        inv.camp_id, inv.id, caller, p_camper_name, p_division, p_grade, p_bunk,
        inv.parent_name, inv.parent_email, coalesce(p_subject, ''), p_body
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$;


-- ─── 5. submit_parent_message — add the camp_connected check ──────────────
-- Only the "start a new conversation" entry point (submit_message_reply is
-- deliberately left alone — replying inside a thread the office already
-- started, e.g. about a lingering billing question, stays open).
CREATE OR REPLACE FUNCTION public.submit_parent_message(
    p_camp_id    uuid,
    p_subject    text,
    p_body       text,
    p_recipients jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller    uuid := auth.uid();
    inv       link_parent_invites;
    thread    uuid := gen_random_uuid();
    rec       jsonb;
    n         int := 0;
BEGIN
    IF caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;
    IF p_body IS NULL OR btrim(p_body) = '' THEN RETURN jsonb_build_object('success', false, 'error', 'missing_body'); END IF;
    IF length(p_body) > 10000 OR length(coalesce(p_subject,'')) > 200 THEN RETURN jsonb_build_object('success', false, 'error', 'too_long'); END IF;

    SELECT * INTO inv FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND camp_id = p_camp_id
    ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'no_active_invite'); END IF;

    -- NEW: this parent's connection to the camp ended — no new message.
    IF NOT inv.camp_connected THEN
        RETURN jsonb_build_object('success', false, 'error', 'camp_disconnected');
    END IF;

    IF p_recipients IS NULL OR jsonb_array_length(p_recipients) = 0 THEN
        INSERT INTO link_messages (id, camp_id, thread_id, direction, parent_name, parent_email, subject, body)
        VALUES (gen_random_uuid(), inv.camp_id, thread, 'in', inv.parent_name, inv.parent_email, coalesce(p_subject,''), p_body);
        n := 1;
    ELSE
        FOR rec IN SELECT * FROM jsonb_array_elements(p_recipients) LOOP
            INSERT INTO link_messages (id, camp_id, thread_id, direction, parent_name, parent_email, subject, body, recipient_user_id, recipient_label)
            VALUES (gen_random_uuid(), inv.camp_id, thread, 'in', inv.parent_name, inv.parent_email, coalesce(p_subject,''), p_body,
                    NULLIF(rec->>'user_id','')::uuid, rec->>'label');
            n := n + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object('success', true, 'thread_id', thread, 'sent', n);
END;
$$;
-- Grants unchanged by CREATE OR REPLACE — still authenticated-only, per 027.


-- ─── Sanity checks (run manually after applying) ───────────────────────────
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'link_parent_invites' AND column_name = 'camp_connected';
--
--   -- disconnect a test invite manually and confirm the nav collapses:
--   UPDATE link_parent_invites SET camp_connected = false WHERE id = '<a test invite id>';
--   -- then as that parent: select get_my_link_features();
--   -- expect features.canteen/shop/tips/mail/pickup/messages/schedule/
--   -- forms/lists/health/emergency = false, features.payments/photos absent
--   -- (still enabled) — and confirm get_my_balance()/get_camp_photos_browse()
--   -- still succeed for that same parent.
--
--   -- confirm the new checks are actually in each function body:
--   SELECT prosrc FROM pg_proc WHERE proname IN
--     ('submit_shop_order','submit_camper_mail','submit_parent_message')
--   -- each should contain 'camp_disconnected'
-- ============================================================================
