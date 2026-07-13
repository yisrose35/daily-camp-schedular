-- ============================================================================
-- Migration: make the parent SECURITY DEFINER RPCs camp-aware
--
-- Every parent RPC resolves "the caller's invite" with:
--     WHERE user_id = caller AND status='active' ... ORDER BY created_at DESC LIMIT 1
-- i.e. the single MOST-RECENT invite. This silently breaks when a parent holds
-- active invites on MORE THAN ONE camp (siblings at different camps, or a parent
-- who is also staff/owner of their own camp): the RPC locks onto whichever
-- invite is newest, so messages/deposits/reads for the camp the parent is
-- actually viewing either return nothing or fail with 'camper_not_on_invite'.
--
-- Fix: add an optional p_camp_id. When provided, resolve the invite for THAT
-- camp; when NULL, fall back to the most-recent invite (fully backward
-- compatible with existing callers). The parent portal passes parent.campId.
--
-- Adding a parameter changes each function's signature, so we DROP the old
-- signature and CREATE the new one with p_camp_id uuid DEFAULT NULL (the default
-- keeps 0/2/3-arg callers working).
-- ============================================================================

-- ─── 1. submit_canteen_deposit (was text, numeric) ───────────────────────────
DROP FUNCTION IF EXISTS public.submit_canteen_deposit(text, numeric);
CREATE OR REPLACE FUNCTION public.submit_canteen_deposit(
    p_camper_name text,
    p_amount      numeric,
    p_camp_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    v_value jsonb;
    v_bal   numeric;
    now_ts  timestamptz := now();
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_camper_name IS NULL OR btrim(p_camper_name) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_camper');
    END IF;
    IF p_amount IS NULL OR p_amount < 1 OR p_amount > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    IF inv.camper_names IS NOT NULL AND NOT (inv.camper_names ? p_camper_name) THEN
        RETURN jsonb_build_object('success', false, 'error', 'camper_not_on_invite');
    END IF;

    INSERT INTO camp_state_kv (camp_id, key, value, updated_at)
    VALUES (inv.camp_id, 'campistrySnacks', '{"accounts":{},"transactions":[]}'::jsonb, now_ts)
    ON CONFLICT (camp_id, key) DO NOTHING;

    SELECT value INTO v_value
    FROM camp_state_kv
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks'
    FOR UPDATE;

    IF v_value IS NULL THEN v_value := '{"accounts":{},"transactions":[]}'::jsonb; END IF;
    IF v_value->'accounts' IS NULL THEN v_value := jsonb_set(v_value, '{accounts}', '{}'::jsonb); END IF;
    IF v_value->'transactions' IS NULL THEN v_value := jsonb_set(v_value, '{transactions}', '[]'::jsonb); END IF;

    v_bal := round(COALESCE((v_value->'accounts'->p_camper_name->>'balance')::numeric, 0) + p_amount, 2);

    v_value := jsonb_set(
        v_value, ARRAY['accounts', p_camper_name],
        COALESCE(v_value->'accounts'->p_camper_name, '{"dailyLimit":10,"spentToday":0}'::jsonb)
            || jsonb_build_object('balance', v_bal),
        true
    );

    v_value := jsonb_set(
        v_value, '{transactions}',
        jsonb_build_array(jsonb_build_object(
            'time',   to_char(now_ts, 'HH12:MI AM'),
            'camper', p_camper_name,
            'items',  'Funds added by parent',
            'amount', p_amount,
            'type',   'credit',
            'date',   to_char(now_ts, 'YYYY-MM-DD')
        )) || COALESCE(v_value->'transactions', '[]'::jsonb)
    );

    UPDATE camp_state_kv
    SET value = v_value, updated_at = now_ts
    WHERE camp_id = inv.camp_id AND key = 'campistrySnacks';

    RETURN jsonb_build_object('success', true, 'balance', v_bal);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_canteen_deposit(text, numeric, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_canteen_deposit(text, numeric, uuid) TO authenticated;

-- ─── 2. get_my_messages (was no args) ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_my_messages();
CREATE OR REPLACE FUNCTION public.get_my_messages(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
    result jsonb;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id',         m.id,
        'thread_id',  m.thread_id,
        'direction',  m.direction,
        'subject',    m.subject,
        'body',       m.body,
        'read',       m.read,
        'archived',   m.archived_for_parent,
        'created_at', m.created_at
    ) ORDER BY m.created_at DESC), '[]'::jsonb)
    INTO result
    FROM link_messages m
    WHERE m.camp_id = inv.camp_id
      AND m.parent_email = inv.parent_email
      AND m.hidden_for_parent = false
    LIMIT 200;

    RETURN jsonb_build_object('success', true, 'messages', result);
END;
$$;
REVOKE ALL ON FUNCTION public.get_my_messages(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_my_messages(uuid) TO authenticated;

-- ─── 3. submit_message_reply (was uuid, text, text) ──────────────────────────
DROP FUNCTION IF EXISTS public.submit_message_reply(uuid, text, text);
CREATE OR REPLACE FUNCTION public.submit_message_reply(
    p_thread_id uuid DEFAULT NULL,
    p_subject   text DEFAULT '',
    p_body      text DEFAULT '',
    p_camp_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller  uuid := auth.uid();
    inv     link_parent_invites;
    new_id  uuid := gen_random_uuid();
    use_thread uuid;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;
    IF p_body IS NULL OR btrim(p_body) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_body');
    END IF;
    IF length(p_body) > 10000 OR length(coalesce(p_subject,'')) > 200 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_long');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    use_thread := new_id;
    IF p_thread_id IS NOT NULL THEN
        PERFORM 1 FROM link_messages
        WHERE thread_id = p_thread_id AND camp_id = inv.camp_id AND parent_email = inv.parent_email
        LIMIT 1;
        IF FOUND THEN use_thread := p_thread_id; END IF;
    END IF;

    INSERT INTO link_messages (
        id, camp_id, thread_id, direction, parent_name, parent_email, subject, body
    ) VALUES (
        new_id, inv.camp_id, use_thread, 'in', inv.parent_name, inv.parent_email,
        coalesce(p_subject, ''), p_body
    );

    RETURN jsonb_build_object('success', true, 'id', new_id, 'thread_id', use_thread);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_message_reply(uuid, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_message_reply(uuid, text, text, uuid) TO authenticated;

-- ─── 4. mark_message_read (was uuid) ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.mark_message_read(uuid);
CREATE OR REPLACE FUNCTION public.mark_message_read(p_message_id uuid, p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    UPDATE link_messages
    SET read = true
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email
      AND direction = 'out';

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_message_read(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_message_read(uuid, uuid) TO authenticated;

-- ─── 5. delete_my_message (was uuid) ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.delete_my_message(uuid);
CREATE OR REPLACE FUNCTION public.delete_my_message(p_message_id uuid, p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    UPDATE link_messages
    SET hidden_for_parent = true
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_my_message(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_my_message(uuid, uuid) TO authenticated;

-- ─── 6. set_my_message_archived (was uuid, boolean) ──────────────────────────
DROP FUNCTION IF EXISTS public.set_my_message_archived(uuid, boolean);
CREATE OR REPLACE FUNCTION public.set_my_message_archived(p_message_id uuid, p_archived boolean, p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    caller uuid := auth.uid();
    inv    link_parent_invites;
BEGIN
    IF caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
    END IF;

    SELECT * INTO inv
    FROM link_parent_invites
    WHERE user_id = caller AND status = 'active'
      AND (p_camp_id IS NULL OR camp_id = p_camp_id)
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_active_invite');
    END IF;

    UPDATE link_messages
    SET archived_for_parent = coalesce(p_archived, false)
    WHERE id = p_message_id
      AND camp_id = inv.camp_id
      AND parent_email = inv.parent_email;

    RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_message_archived(uuid, boolean, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.set_my_message_archived(uuid, boolean, uuid) TO authenticated;

-- ─── Sanity check ─────────────────────────────────────────────────────────────
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname IN
--     ('submit_canteen_deposit','get_my_messages','submit_message_reply',
--      'mark_message_read','delete_my_message','set_my_message_archived');
