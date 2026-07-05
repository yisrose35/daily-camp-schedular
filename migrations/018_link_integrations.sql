-- ============================================================================
-- Migration 018: link_integrations — wire the parent portal into the suite
--
-- Before this migration every Link ↔ product exchange happened through the
-- browser's localStorage, so it only worked when the parent and the camp
-- staff shared one physical device. This migration adds the cloud relays:
--
--   §1  link_parent_requests  — Pickup & Arrival / Late Arrival → Campistry
--       Live. Parents submit via RPC; Live staff read + confirm/decline via
--       RLS; parents read the status back via RPC.
--   §2  link_canteen_ops      — parent Add Funds / spending controls →
--       Campistry Snacks. Ops-ledger pattern: each parent action is a row the
--       POS applies to its canonical store (camp_state_kv.campistrySnacks)
--       and marks applied — no blob-clobber races. get_my_canteen() lets the
--       parent read real balances/transactions from the camp's store.
--   §3  link_health_docs      — parent medical-document uploads → Campistry
--       Health (with the actual file this time), plus get_my_nurse_log()
--       so parents see their campers' nurse visits from
--       camp_state_kv.campistryHealth.
--   §4  Live camper data      — get_parent_data_by_user / claim_parent_invite
--       / claim_invite_by_code now overlay the invite-time snapshot with the
--       CURRENT Me-page roster + enrollment record (camp_state_kv 'app1' and
--       'campistryMe'), so bunk moves and medical edits reach parents without
--       re-issuing invites.
--   §5  get_link_tips_config  — now also returns the camp's real staff
--       roster (name + role, from campistryMe.finance.staff) so tip
--       categories with no typed names show actual staff, as the admin UI
--       has always promised.
--
-- Same security model as migrations 007–017: parents never touch tables or
-- camp_state_kv directly — only SECURITY DEFINER RPCs that resolve the
-- caller's active invite from auth.uid() and scope every read/write to the
-- campers on that invite. Camp staff use RLS gated on get_user_camp_id().
-- ============================================================================


-- ─── Shared helper: camper's CURRENT bunk ────────────────────────────────────
-- Prefers the live Me-page roster (camp_state_kv 'app1' → camperRoster) so
-- staff see where the camper actually is today; falls back to the invite
-- snapshot for camps that never synced Me to the cloud.
CREATE OR REPLACE FUNCTION public.link_current_bunk(
    p_camp_id  uuid,
    p_name     text,
    p_snapshot jsonb
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
    SELECT coalesce(
        NULLIF((SELECT value -> 'camperRoster' -> p_name ->> 'bunk'
                FROM camp_state_kv
                WHERE camp_id = p_camp_id AND key = 'app1' LIMIT 1), ''),
        p_snapshot -> p_name ->> 'bunk',
        ''
    )
$$;

REVOKE ALL ON FUNCTION public.link_current_bunk(uuid, text, jsonb) FROM public;
-- internal helper: used by the SECURITY DEFINER RPCs below (no direct grants)


-- ═══ §1  PICKUP & ARRIVAL → CAMPISTRY LIVE ═══════════════════════════════════

CREATE TABLE IF NOT EXISTS link_parent_requests (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    invite_id    uuid,
    user_id      uuid,
    parent_name  text        NOT NULL DEFAULT '',
    camper_name  text        NOT NULL DEFAULT '',
    bunk         text        NOT NULL DEFAULT '',
    type         text        NOT NULL,                -- early | change | friend | late
    label        text        NOT NULL DEFAULT '',     -- display label at submit time
    fields       jsonb       NOT NULL DEFAULT '{}',   -- type-specific payload
    status       text        NOT NULL DEFAULT 'Pending',  -- Pending | Confirmed | Released | Declined
    status_note  text,
    request_date date        NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
    created_at   timestamptz NOT NULL DEFAULT now(),
    reviewed_at  timestamptz,
    reviewed_by  uuid,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_parent_requests_camp_date
    ON link_parent_requests (camp_id, request_date);
CREATE INDEX IF NOT EXISTS idx_link_parent_requests_user
    ON link_parent_requests (user_id);

ALTER TABLE link_parent_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_parent_requests_select ON link_parent_requests;
CREATE POLICY link_parent_requests_select ON link_parent_requests
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- Live staff confirm/decline requests (status + note only in practice)
DROP POLICY IF EXISTS link_parent_requests_update ON link_parent_requests;
CREATE POLICY link_parent_requests_update ON link_parent_requests
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    )
    WITH CHECK (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS link_parent_requests_delete ON link_parent_requests;
CREATE POLICY link_parent_requests_delete ON link_parent_requests
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

-- Table privileges (RLS still gates rows). Supabase grants these by default;
-- stated explicitly so the migration is self-contained on any Postgres.
GRANT SELECT, UPDATE, DELETE ON link_parent_requests TO authenticated;

-- Parent write path
CREATE OR REPLACE FUNCTION public.submit_parent_request(
    p_type        text,
    p_label       text,
    p_camper_name text,
    p_fields      jsonb DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_type IS NULL OR p_type NOT IN ('early','change','friend','late') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_type');
    END IF;
    IF length(coalesce(p_fields::text, '')) > 16384 THEN
        RETURN jsonb_build_object('success', false, 'error', 'fields_too_large');
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

    -- Camper must belong to this parent's invite
    IF p_camper_name IS NULL OR p_camper_name = ''
       OR NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    -- Throttle: max 20 requests per parent per day
    IF (SELECT count(*) FROM link_parent_requests
        WHERE invite_id = inv.id
          AND request_date = (now() AT TIME ZONE 'utc')::date) >= 20 THEN
        RETURN jsonb_build_object('success', false, 'error', 'daily_limit_reached');
    END IF;

    INSERT INTO link_parent_requests
        (camp_id, invite_id, user_id, parent_name, camper_name, bunk, type, label, fields)
    VALUES (
        inv.camp_id, inv.id, caller, coalesce(inv.parent_name,''),
        p_camper_name,
        public.link_current_bunk(inv.camp_id, p_camper_name, inv.camper_data),
        p_type, coalesce(p_label,''),
        coalesce(p_fields, '{}'::jsonb)
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_parent_request(text, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_parent_request(text, text, text, jsonb) TO authenticated;

-- Parent read path — own requests, last 7 days (status updates from Live)
CREATE OR REPLACE FUNCTION public.get_my_parent_requests()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    reqs   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',          r.id,
        'type',        r.type,
        'label',       r.label,
        'camper_name', r.camper_name,
        'fields',      r.fields,
        'status',      r.status,
        'status_note', r.status_note,
        'request_date',r.request_date,
        'created_at',  r.created_at
    ) ORDER BY r.created_at DESC), '[]'::jsonb)
    INTO reqs
    FROM link_parent_requests r
    WHERE r.user_id = caller
      AND r.request_date >= (now() AT TIME ZONE 'utc')::date - 7;

    RETURN jsonb_build_object('success', true, 'requests', reqs);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_parent_requests() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_parent_requests() TO authenticated;


-- ═══ §2  CANTEEN → CAMPISTRY SNACKS ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS link_canteen_ops (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    invite_id    uuid,
    user_id      uuid,
    parent_name  text        NOT NULL DEFAULT '',
    camper_name  text        NOT NULL DEFAULT '',
    op           text        NOT NULL,                -- add_funds | set_controls
    amount       numeric(10,2),                       -- add_funds
    controls     jsonb,                               -- set_controls: {dailyLimit, creditLimit, balanceFloor}
    status       text        NOT NULL DEFAULT 'pending',  -- pending | applied
    created_at   timestamptz NOT NULL DEFAULT now(),
    applied_at   timestamptz,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_canteen_ops_camp_status
    ON link_canteen_ops (camp_id, status);
CREATE INDEX IF NOT EXISTS idx_link_canteen_ops_user
    ON link_canteen_ops (user_id);

ALTER TABLE link_canteen_ops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_canteen_ops_select ON link_canteen_ops;
CREATE POLICY link_canteen_ops_select ON link_canteen_ops
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

-- POS marks ops applied
DROP POLICY IF EXISTS link_canteen_ops_update ON link_canteen_ops;
CREATE POLICY link_canteen_ops_update ON link_canteen_ops
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    )
    WITH CHECK (camp_id = get_user_camp_id());

GRANT SELECT, UPDATE ON link_canteen_ops TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_canteen_op(
    p_camper_name text,
    p_op          text,
    p_amount      numeric DEFAULT NULL,
    p_controls    jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_op IS NULL OR p_op NOT IN ('add_funds','set_controls') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_op');
    END IF;
    IF p_op = 'add_funds' AND (p_amount IS NULL OR p_amount <= 0 OR p_amount > 500) THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
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
    IF p_camper_name IS NULL OR NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO link_canteen_ops
        (camp_id, invite_id, user_id, parent_name, camper_name, op, amount, controls)
    VALUES (
        inv.camp_id, inv.id, caller, coalesce(inv.parent_name,''),
        p_camper_name, p_op,
        CASE WHEN p_op = 'add_funds' THEN round(p_amount, 2) END,
        CASE WHEN p_op = 'set_controls' THEN p_controls END
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_canteen_op(text, text, numeric, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_op(text, text, numeric, jsonb) TO authenticated;

-- Parent read path: real balances + transactions from the camp's Snacks store
-- (camp_state_kv key 'campistrySnacks'), scoped to the caller's campers, plus
-- the caller's still-pending ops so the UI can show "processing" credits.
CREATE OR REPLACE FUNCTION public.get_my_canteen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_store jsonb;
    v_accts jsonb := '{}'::jsonb;
    v_tx    jsonb := '[]'::jsonb;
    v_ops   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    SELECT value INTO v_store
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks'
    LIMIT 1;

    IF v_store IS NOT NULL THEN
        -- Accounts for this parent's campers only
        SELECT coalesce(jsonb_object_agg(n, v_store -> 'accounts' -> n), '{}'::jsonb)
        INTO v_accts
        FROM jsonb_array_elements_text(inv.camper_names) AS n
        WHERE v_store -> 'accounts' ? n;

        -- Their transactions only (most recent 100)
        SELECT coalesce(jsonb_agg(t.tx), '[]'::jsonb)
        INTO v_tx
        FROM (
            SELECT tx
            FROM jsonb_array_elements(coalesce(v_store -> 'transactions', '[]'::jsonb))
                 WITH ORDINALITY AS e(tx, ord)
            WHERE inv.camper_names ? (e.tx ->> 'camper')
            ORDER BY e.ord
            LIMIT 100
        ) t;
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id, 'camper_name', o.camper_name, 'op', o.op,
        'amount', o.amount, 'controls', o.controls, 'created_at', o.created_at
    ) ORDER BY o.created_at DESC), '[]'::jsonb)
    INTO v_ops
    FROM link_canteen_ops o
    WHERE o.user_id = caller AND o.status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'accounts', v_accts,
        'transactions', v_tx,
        'pending_ops', v_ops
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_canteen() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_canteen() TO authenticated;


-- ═══ §3  HEALTH DOCS + NURSE LOG ═════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS link_health_docs (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    camp_id      uuid        NOT NULL,
    invite_id    uuid,
    user_id      uuid,
    parent_name  text        NOT NULL DEFAULT '',
    camper_name  text        NOT NULL DEFAULT '',
    bunk         text        NOT NULL DEFAULT '',
    file_name    text        NOT NULL DEFAULT '',
    file_data    text,                                -- data URL (same pattern as link_form_responses)
    status       text        NOT NULL DEFAULT 'pending',  -- pending | approved | flagged
    review_note  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    reviewed_at  timestamptz,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_link_health_docs_camp
    ON link_health_docs (camp_id);
CREATE INDEX IF NOT EXISTS idx_link_health_docs_user
    ON link_health_docs (user_id);

ALTER TABLE link_health_docs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS link_health_docs_select ON link_health_docs;
CREATE POLICY link_health_docs_select ON link_health_docs
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    );

DROP POLICY IF EXISTS link_health_docs_update ON link_health_docs;
CREATE POLICY link_health_docs_update ON link_health_docs
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'scheduler'::text])
    )
    WITH CHECK (camp_id = get_user_camp_id());

DROP POLICY IF EXISTS link_health_docs_delete ON link_health_docs;
CREATE POLICY link_health_docs_delete ON link_health_docs
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text])
    );

GRANT SELECT, UPDATE, DELETE ON link_health_docs TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_health_doc(
    p_camper_name text,
    p_file_name   text,
    p_file_data   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    new_id uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_file_name IS NULL OR p_file_name = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;
    -- ≈10 MB as base64 — matches the parent UI's stated limit
    IF length(coalesce(p_file_data, '')) > 14680064 THEN
        RETURN jsonb_build_object('success', false, 'error', 'file_too_large');
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
    IF p_camper_name IS NULL OR NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO link_health_docs
        (camp_id, invite_id, user_id, parent_name, camper_name, bunk, file_name, file_data)
    VALUES (
        inv.camp_id, inv.id, caller, coalesce(inv.parent_name,''),
        p_camper_name,
        public.link_current_bunk(inv.camp_id, p_camper_name, inv.camper_data),
        p_file_name, p_file_data
    )
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_health_doc(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_health_doc(text, text, text) TO authenticated;

-- Parent read path — own uploaded docs with review status (no file body)
CREATE OR REPLACE FUNCTION public.get_my_health_docs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    docs   jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'camper_name', d.camper_name, 'file_name', d.file_name,
        'status', d.status, 'review_note', d.review_note,
        'created_at', d.created_at, 'reviewed_at', d.reviewed_at
    ) ORDER BY d.created_at DESC), '[]'::jsonb)
    INTO docs
    FROM link_health_docs d
    WHERE d.user_id = caller;

    RETURN jsonb_build_object('success', true, 'docs', docs);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_health_docs() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_health_docs() TO authenticated;

-- Parent read path — nurse visits for the caller's campers, from the Health
-- app's store (camp_state_kv key 'campistryHealth', synced by campistry_health.js).
-- Returns only parent-appropriate fields.
CREATE OR REPLACE FUNCTION public.get_my_nurse_log()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller   uuid := auth.uid();
    inv      link_parent_invites;
    v_health jsonb;
    visits   jsonb := '[]'::jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    SELECT value INTO v_health
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistryHealth'
    LIMIT 1;

    IF v_health IS NOT NULL THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'camper_name', v.visit ->> 'camperName',
            'complaint',   v.visit ->> 'complaint',
            'treatment',   v.visit ->> 'treatment',
            'disposition', v.visit ->> 'disposition',
            'nurse',       v.visit ->> 'nurse',
            'date',        v.visit ->> 'date',
            'time',        v.visit ->> 'time',
            'timestamp',   v.visit -> 'timestamp'
        ) ORDER BY v.ord DESC), '[]'::jsonb)
        INTO visits
        FROM jsonb_array_elements(coalesce(v_health -> 'sickVisits', '[]'::jsonb))
             WITH ORDINALITY AS v(visit, ord)
        WHERE inv.camper_names ? (v.visit ->> 'camperName');
    END IF;

    RETURN jsonb_build_object('success', true, 'visits', visits);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_nurse_log() FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_nurse_log() TO authenticated;


-- ═══ §4  LIVE CAMPER DATA FROM ME (roster + enrollments) ═════════════════════

-- Overlays the invite-time snapshot with the CURRENT Me-page data:
--   • camp_state_kv 'app1'        → value.camperRoster[name]   (structure wins:
--     division/grade/bunk always come from the roster when present)
--   • camp_state_kv 'campistryMe' → value.enrollments (matched by camperName;
--     medical/contact fields win over roster, mirroring generateParentInvite)
-- Falls back to the snapshot wherever cloud data is missing, so camps that
-- never synced Me to the cloud behave exactly as before.
CREATE OR REPLACE FUNCTION public.link_live_camper_data(
    p_camp_id  uuid,
    p_names    jsonb,
    p_snapshot jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_roster jsonb;
    v_enrs   jsonb;
    result   jsonb := '{}'::jsonb;
    n        text;
    base     jsonb;
    r        jsonb;
    e        jsonb;
    merged   jsonb;
BEGIN
    SELECT value -> 'camperRoster' INTO v_roster
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'app1' LIMIT 1;

    SELECT value -> 'enrollments' INTO v_enrs
    FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistryMe' LIMIT 1;

    FOR n IN SELECT jsonb_array_elements_text(coalesce(p_names, '[]'::jsonb))
    LOOP
        base := coalesce(p_snapshot -> n, '{}'::jsonb);
        r    := coalesce(v_roster -> n, '{}'::jsonb);

        -- Latest enrollment for this camper (accepted/enrolled preferred)
        e := '{}'::jsonb;
        IF v_enrs IS NOT NULL AND jsonb_typeof(v_enrs) = 'object' THEN
            SELECT coalesce(en.value, '{}'::jsonb) INTO e
            FROM jsonb_each(v_enrs) AS en(key, value)
            WHERE en.value ->> 'camperName' = n
            ORDER BY (en.value ->> 'status' IN ('accepted','enrolled')) DESC,
                     coalesce(en.value ->> 'appliedDate', '') DESC
            LIMIT 1;
            e := coalesce(e, '{}'::jsonb);
        END IF;

        merged := jsonb_build_object(
            'name',           n,
            'dob',            coalesce(NULLIF(e->>'dob',''),            NULLIF(r->>'dob',''),            base->>'dob',            ''),
            'gender',         coalesce(NULLIF(e->>'gender',''),         NULLIF(r->>'gender',''),         base->>'gender',         ''),
            'division',       coalesce(NULLIF(r->>'division',''),       base->>'division',       ''),
            'grade',          coalesce(NULLIF(r->>'grade',''),          base->>'grade',          ''),
            'bunk',           coalesce(NULLIF(r->>'bunk',''),           base->>'bunk',           ''),
            'session',        coalesce(NULLIF(e->>'session',''),        base->>'session',        ''),
            'counselor',      coalesce(NULLIF(r->>'counselor',''),      base->>'counselor',      ''),
            'allergies',      coalesce(NULLIF(e->>'allergies',''),      NULLIF(r->>'allergies',''),      base->>'allergies',      ''),
            'medications',    coalesce(NULLIF(e->>'medications',''),    NULLIF(r->>'medications',''),    base->>'medications',    ''),
            'dietary',        coalesce(NULLIF(e->>'dietary',''),        NULLIF(r->>'dietary',''),        base->>'dietary',        ''),
            'doctor',         coalesce(NULLIF(e->>'doctor',''),         NULLIF(r->>'doctor',''),         base->>'doctor',         ''),
            'doctorPhone',    coalesce(NULLIF(e->>'doctorPhone',''),    NULLIF(r->>'doctorPhone',''),    base->>'doctorPhone',    ''),
            'insurance',      coalesce(NULLIF(e->>'insurance',''),      NULLIF(r->>'insurance',''),      base->>'insurance',      ''),
            'policyNum',      coalesce(NULLIF(e->>'policyNum',''),      NULLIF(r->>'policyNum',''),      base->>'policyNum',      ''),
            'emergencyName',  coalesce(NULLIF(e->>'emergencyName',''),  NULLIF(r->>'emergencyName',''),  base->>'emergencyName',  ''),
            'emergencyPhone', coalesce(NULLIF(e->>'emergencyPhone',''), NULLIF(r->>'emergencyPhone',''), base->>'emergencyPhone', ''),
            'emergencyRel',   coalesce(NULLIF(e->>'emergencyRel',''),   NULLIF(r->>'emergencyRel',''),   base->>'emergencyRel',   ''),
            'parent2Name',    coalesce(NULLIF(e->>'parent2Name',''),    NULLIF(r->>'parent2Name',''),    base->>'parent2Name',    ''),
            'parent2Phone',   coalesce(NULLIF(e->>'parent2Phone',''),   NULLIF(r->>'parent2Phone',''),   base->>'parent2Phone',   '')
        );
        result := result || jsonb_build_object(n, merged);
    END LOOP;

    RETURN result;
EXCEPTION WHEN OTHERS THEN
    -- Any malformed cloud state → serve the snapshot untouched
    RETURN coalesce(p_snapshot, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.link_live_camper_data(uuid, jsonb, jsonb) FROM public;
-- internal helper: callable only by the definer's RPCs below (no direct grants)

-- Rebuild the three parent-data RPCs on top of the live helper
CREATE OR REPLACE FUNCTION public.get_parent_data_by_user()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv    link_parent_invites;
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_invite_found');
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', inv.camper_names,
        'camper_data',  public.link_live_camper_data(inv.camp_id, inv.camper_names, inv.camper_data)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_parent_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv    link_parent_invites;
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE token = p_token
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_or_expired');
    END IF;

    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    UPDATE link_parent_invites
    SET user_id = caller
    WHERE id = inv.id;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', inv.camper_names,
        'camper_data',  public.link_live_camper_data(inv.camp_id, inv.camper_names, inv.camper_data)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_invite_by_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    inv    link_parent_invites;
    caller uuid := auth.uid();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE upper(access_code) = upper(coalesce(p_code, ''))
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_code');
    END IF;

    IF inv.user_id IS NOT NULL AND inv.user_id <> caller THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed');
    END IF;

    UPDATE link_parent_invites
    SET user_id = caller
    WHERE id = inv.id;

    RETURN jsonb_build_object(
        'success',      true,
        'camp_id',      inv.camp_id,
        'parent_name',  inv.parent_name,
        'parent_email', inv.parent_email,
        'family_id',    inv.family_id,
        'camper_names', inv.camper_names,
        'camper_data',  public.link_live_camper_data(inv.camp_id, inv.camper_names, inv.camper_data)
    );
END;
$$;


-- ═══ §5  TIPS CONFIG + REAL STAFF ROSTER FROM ME ═════════════════════════════

-- Adds 'staff' — the camp's staff roster (name + role only, no salaries) from
-- campistryMe.finance.staff — so tip categories left blank list real staff,
-- exactly as the admin UI promises.
CREATE OR REPLACE FUNCTION public.get_link_tips_config(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_value text;
    v_me    jsonb;
    v_staff jsonb := '[]'::jsonb;
BEGIN
    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = p_camp_id
      AND key     = 'link_tips_config'
    LIMIT 1;

    SELECT value INTO v_me
    FROM camp_state_kv
    WHERE camp_id = p_camp_id
      AND key     = 'campistryMe'
    LIMIT 1;

    IF v_me IS NOT NULL THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'name', s.st ->> 'name',
            'role', coalesce(s.st ->> 'role', 'Staff')
        )), '[]'::jsonb)
        INTO v_staff
        FROM jsonb_array_elements(coalesce(v_me -> 'finance' -> 'staff', '[]'::jsonb)) AS s(st)
        WHERE coalesce(s.st ->> 'name', '') <> '';
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'config',  CASE WHEN v_value IS NULL THEN NULL ELSE v_value::jsonb END,
        'staff',   v_staff
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.get_link_tips_config(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_link_tips_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_link_tips_config(uuid) TO anon;

-- ============================================================================
-- Sanity checks:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename IN ('link_parent_requests','link_canteen_ops','link_health_docs');
-- ============================================================================
