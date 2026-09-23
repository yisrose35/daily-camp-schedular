-- ============================================================================
-- Migration 254: erasing a camper removes everything tied to their number,
-- and only then is the number free.
--
-- THE RULE (253). A number belongs to one person at a time. A camper removed
-- from the roster is DEPARTED: their number stays theirs and their history
-- stays attached, because a removal might be a mistake (Undo, or a stale tab
-- that saved an old roster). Nothing is destroyed on absence alone.
--
-- ERASING is the deliberate act that ends it. erase_camper(camp, number):
--
--   * DELETES every row that belongs to the camper: every table with a
--     person_id (found in the catalog, so a table added later is covered too),
--     the canteen ledger (canteen_transactions.camper_id), the canteen account,
--     and older rows that name the camper but were never stamped with the
--     number. That covers health documents, form responses, mail, photo tags,
--     face data, pickup requests and alerts.
--   * DETACHES the family's money records: tuition enrollments, card
--     checkouts, tips and photo purchases. They are the FAMILY's accounts and
--     the processor's receipts, so deleting them would change what a family
--     owes or erase proof of a payment. They keep the amount and lose the
--     camper: person_id is cleared and the name is replaced with
--     "(erased camper)", so no later lookup can re-attach them to anyone.
--   * removes the camper from their parents' invitations (name, number and
--     details at that position).
--   * scrubs the camp's saved documents (health logs, bunk lists, the legacy
--     canteen and shop documents and the rest): every record carrying the
--     number, and when no enrolled camper has the same name, every record,
--     list entry and key carrying the name. Family money in those documents
--     (families, payments, invoices, installments, enrollments, orders) is
--     left alone, for the same reason as above.
--   * queues the camper's stored PDF files for deletion
--     (camp_erased_files; the erase-camper-files edge function deletes them,
--     because SQL cannot delete from Storage).
--   * finally DELETES the camper's identity row. Only now is the number free:
--     the next camper given it starts with nothing.
--
-- IT REFUSES
--   * a camper who is still on the roster: delete them from the roster first
--     (this is what makes a stale save or a mistake recoverable);
--   * a camper whose canteen account holds money: refund it or zero it first,
--     so no parent's money disappears silently.
--
-- p_confirm = false (the default) is a dry run: it reports what would go.
--
-- WHO. The camp's owner or an admin; the service role; the SQL Editor.
--
-- HOW TO APPLY. Paste into the SQL Editor after 253, then deploy the new
-- erase-camper-files edge function.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public._person_reference_columns()') IS NULL THEN
        RAISE EXCEPTION '254 needs 238 (_person_reference_columns) — apply it first';
    END IF;
    IF to_regprocedure('public._stated_person_id(text)') IS NULL THEN
        RAISE EXCEPTION '254 needs 253 — apply it first';
    END IF;
END $$;


-- Stored files waiting to be deleted by the erase-camper-files edge function.
CREATE TABLE IF NOT EXISTS public.camp_erased_files (
    id        bigserial PRIMARY KEY,
    camp_id   uuid        NOT NULL,
    bucket    text        NOT NULL,
    path      text        NOT NULL,
    queued_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.camp_erased_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_erased_files FROM public, anon, authenticated;


-- The family's money: detached, not deleted.
CREATE OR REPLACE FUNCTION public._erase_keeps_money_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT ARRAY['camp_billing_enrollments', 'cardknox_checkout_intents',
                 'link_tips', 'link_photo_purchases', 'camp_payments']
$$;

-- Family money inside the saved documents: left as it is.
CREATE OR REPLACE FUNCTION public._erase_keeps_money_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT ARRAY['families', 'payments', 'finance', 'invoices', 'installments',
                 'enrollments', 'orders', 'billing', 'refunds', 'charges']
$$;


-- ─── scrub one document ─────────────────────────────────────────────────────
-- Removes: array elements that are records carrying the number (camperId /
-- personId / person_id / camper_id); and when p_name is given (no enrolled
-- camper shares it) array elements naming the camper (camperName / camper, or
-- the bare name in a list) and object keys equal to the name. Subtrees under a
-- money key are returned untouched.
CREATE OR REPLACE FUNCTION public._scrub_person_json(p_doc jsonb, p_id bigint, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_out  jsonb;
    e      record;
    v_keep text[] := public._erase_keeps_money_keys();
BEGIN
    IF jsonb_typeof(p_doc) = 'object' THEN
        v_out := '{}'::jsonb;
        FOR e IN SELECT key, value FROM jsonb_each(p_doc) LOOP
            IF p_name IS NOT NULL AND e.key = p_name THEN
                CONTINUE;
            ELSIF e.key = ANY (v_keep) THEN
                v_out := v_out || jsonb_build_object(e.key, e.value);
            ELSE
                v_out := v_out || jsonb_build_object(e.key, public._scrub_person_json(e.value, p_id, p_name));
            END IF;
        END LOOP;
        RETURN v_out;
    ELSIF jsonb_typeof(p_doc) = 'array' THEN
        v_out := '[]'::jsonb;
        FOR e IN SELECT value FROM jsonb_array_elements(p_doc) LOOP
            IF jsonb_typeof(e.value) = 'object' AND (
                   public._stated_person_id(e.value ->> 'camperId')  = p_id
                OR public._stated_person_id(e.value ->> 'personId')  = p_id
                OR public._stated_person_id(e.value ->> 'person_id') = p_id
                OR public._stated_person_id(e.value ->> 'camper_id') = p_id
                OR (p_name IS NOT NULL AND (e.value ->> 'camperName' = p_name
                                            OR e.value ->> 'camper' = p_name))) THEN
                CONTINUE;
            ELSIF p_name IS NOT NULL AND jsonb_typeof(e.value) = 'string'
                  AND e.value #>> '{}' = p_name THEN
                CONTINUE;
            END IF;
            v_out := v_out || jsonb_build_array(public._scrub_person_json(e.value, p_id, p_name));
        END LOOP;
        RETURN v_out;
    END IF;
    RETURN p_doc;
END;
$$;


-- ─── the erase ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erase_camper(
    p_camp_id   uuid,
    p_person_id bigint,
    p_confirm   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims  text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_p       camp_people%ROWTYPE;
    v_names   text[];
    v_scrub   text;                 -- the name, when no enrolled camper shares it
    v_bal     numeric;
    t         record;
    v_n       bigint;
    v_deleted jsonb := '{}'::jsonb;
    v_detach  jsonb := '{}'::jsonb;
    v_docs    text[] := '{}';
    v_files   bigint := 0;
    v_inv     bigint := 0;
    v_money   text[] := public._erase_keeps_money_tables();
    d         record;
    v_new     jsonb;
BEGIN
    -- Who: the camp's owner/admin, the service role, or the SQL Editor (no JWT).
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public._is_camp_admin(p_camp_id, auth.uid()) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_p FROM camp_people
     WHERE camp_id = p_camp_id AND person_id = p_person_id AND kind = 'camper';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_camper');
    END IF;
    IF v_p.deleted_at IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'still_enrolled',
            'detail', v_p.source_key || ' is on the roster. Delete them from the roster first.');
    END IF;

    SELECT COALESCE(sum(balance), 0) INTO v_bal FROM camp_canteen_accounts
     WHERE camp_id = p_camp_id AND person_id = p_person_id;
    IF abs(v_bal) >= 0.005 THEN
        RETURN jsonb_build_object('success', false, 'error', 'canteen_balance',
            'balance', v_bal,
            'detail', 'The canteen account holds ' || to_char(v_bal, 'FM999999990.00')
                   || '. Refund or zero it first.');
    END IF;

    -- The camper's spellings, and whether an ENROLLED camper shares any of them.
    -- A shared name is never used to erase anything: that record may be theirs.
    v_names := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[v_p.source_key, v_p.name]) x
                      WHERE COALESCE(btrim(x), '') <> '');
    IF NOT EXISTS (SELECT 1 FROM camp_people q
                    WHERE q.camp_id = p_camp_id AND q.kind = 'camper' AND q.deleted_at IS NULL
                      AND (q.source_key = ANY (v_names) OR q.name = ANY (v_names))) THEN
        v_scrub := v_p.source_key;
    END IF;

    -- ── stored files first, while the rows still say where they are ─────────
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'link_form_responses'
                  AND column_name = 'filled_pdf_path') THEN
        EXECUTE 'SELECT count(*) FROM link_form_responses
                  WHERE camp_id = $1 AND COALESCE(filled_pdf_path, '''') <> ''''
                    AND (person_id = $2 OR (person_id IS NULL AND $3 IS NOT NULL AND camper_name = $3))'
           INTO v_files USING p_camp_id, p_person_id, v_scrub;
        IF p_confirm AND v_files > 0 THEN
            EXECUTE 'INSERT INTO camp_erased_files (camp_id, bucket, path)
                     SELECT camp_id, ''camp-pdf-forms'', filled_pdf_path FROM link_form_responses
                      WHERE camp_id = $1 AND COALESCE(filled_pdf_path, '''') <> ''''
                        AND (person_id = $2 OR (person_id IS NULL AND $3 IS NOT NULL AND camper_name = $3))'
              USING p_camp_id, p_person_id, v_scrub;
        END IF;
    END IF;

    -- ── rows carrying the number ─────────────────────────────────────────────
    FOR t IN SELECT * FROM public._person_reference_columns() LOOP
        IF t.table_name = ANY (v_money) THEN
            IF t.is_text THEN CONTINUE; END IF;
            EXECUTE format('SELECT count(*) FROM public.%I WHERE camp_id = $1 AND %I = $2',
                           t.table_name, t.column_name) INTO v_n USING p_camp_id, p_person_id;
            IF v_n > 0 THEN
                IF p_confirm THEN
                    IF EXISTS (SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = t.table_name
                                  AND column_name = 'camper_name') THEN
                        EXECUTE format('UPDATE public.%I SET %I = NULL, camper_name = ''(erased camper)'''
                                       || ' WHERE camp_id = $1 AND %I = $2',
                                       t.table_name, t.column_name, t.column_name)
                          USING p_camp_id, p_person_id;
                    ELSE
                        EXECUTE format('UPDATE public.%I SET %I = NULL WHERE camp_id = $1 AND %I = $2',
                                       t.table_name, t.column_name, t.column_name)
                          USING p_camp_id, p_person_id;
                    END IF;
                END IF;
                v_detach := v_detach || jsonb_build_object(t.table_name, v_n);
            END IF;
        ELSE
            IF p_confirm THEN
                EXECUTE format(CASE WHEN t.is_text
                                    THEN 'DELETE FROM public.%I WHERE camp_id = $1 AND %I = $2::text'
                                    ELSE 'DELETE FROM public.%I WHERE camp_id = $1 AND %I = $2' END,
                               t.table_name, t.column_name) USING p_camp_id, p_person_id;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            ELSE
                EXECUTE format(CASE WHEN t.is_text
                                    THEN 'SELECT count(*) FROM public.%I WHERE camp_id = $1 AND %I = $2::text'
                                    ELSE 'SELECT count(*) FROM public.%I WHERE camp_id = $1 AND %I = $2' END,
                               t.table_name, t.column_name) INTO v_n USING p_camp_id, p_person_id;
            END IF;
            IF v_n > 0 THEN
                v_deleted := jsonb_set(v_deleted, ARRAY[t.table_name],
                    to_jsonb(COALESCE((v_deleted ->> t.table_name)::bigint, 0) + v_n));
            END IF;
        END IF;
    END LOOP;

    -- ── older rows that name the camper and were never stamped ───────────────
    IF v_scrub IS NOT NULL THEN
        FOR t IN
            SELECT c.relname::text AS table_name,
                   (SELECT a.attname::text FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                       AND a.attname IN ('camper_name', 'camper')
                     ORDER BY a.attname DESC LIMIT 1) AS name_col,
                   EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                            AND a.attname = 'person_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_pid,
                   EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                            AND a.attname = 'camper_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_cid
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'r'
               AND c.relname NOT IN ('camp_people', 'camp_erased_files')
               AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                            AND a.attname = 'camp_id' AND a.atttypid = 'uuid'::regtype
                            AND a.attnum > 0 AND NOT a.attisdropped)
               AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                            AND a.attname IN ('camper_name', 'camper') AND a.atttypid = 'text'::regtype
                            AND a.attnum > 0 AND NOT a.attisdropped)
        LOOP
            IF t.table_name = ANY (v_money) THEN CONTINUE; END IF;
            -- Only rows with NO number: a row with a number is someone's, and
            -- was handled above if it was this camper's.
            v_new := to_jsonb(format(' FROM public.%I WHERE camp_id = $1 AND %I = ANY ($2)%s%s',
                           t.table_name, t.name_col,
                           CASE WHEN t.has_pid THEN ' AND person_id IS NULL' ELSE '' END,
                           CASE WHEN t.has_cid THEN ' AND COALESCE(camper_id::text, '''') = ''''' ELSE '' END));
            IF p_confirm THEN
                EXECUTE 'DELETE' || (v_new #>> '{}') USING p_camp_id, v_names;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            ELSE
                EXECUTE 'SELECT count(*)' || (v_new #>> '{}') INTO v_n USING p_camp_id, v_names;
            END IF;
            IF COALESCE(v_n, 0) > 0 THEN
                v_deleted := jsonb_set(v_deleted, ARRAY[t.table_name],
                    to_jsonb(COALESCE((v_deleted ->> t.table_name)::bigint, 0) + v_n));
            END IF;
        END LOOP;
    END IF;

    -- ── invitations: the camper leaves the parent's list ─────────────────────
    SELECT count(*) INTO v_inv FROM link_parent_invites i
     WHERE i.camp_id = p_camp_id AND jsonb_typeof(i.person_ids) = 'array'
       AND i.person_ids @> to_jsonb(ARRAY[p_person_id]);
    IF p_confirm AND v_inv > 0 THEN
        UPDATE link_parent_invites i
           SET camper_names = x.names, person_ids = x.ids,
               camper_data = CASE WHEN jsonb_typeof(i.camper_data) = 'object'
                                  THEN i.camper_data - x.gone ELSE i.camper_data END
          FROM (SELECT i2.id,
                       COALESCE(jsonb_agg(n.value ORDER BY n.ord)
                                FILTER (WHERE p.value IS DISTINCT FROM to_jsonb(p_person_id)), '[]') AS names,
                       COALESCE(jsonb_agg(p.value ORDER BY n.ord)
                                FILTER (WHERE p.value IS DISTINCT FROM to_jsonb(p_person_id)), '[]') AS ids,
                       COALESCE(array_agg(n.value #>> '{}')
                                FILTER (WHERE p.value = to_jsonb(p_person_id)), '{}') AS gone
                  FROM link_parent_invites i2
                  CROSS JOIN LATERAL jsonb_array_elements(i2.camper_names) WITH ORDINALITY n(value, ord)
                  LEFT JOIN LATERAL (SELECT i2.person_ids -> (n.ord - 1)::int AS value) p ON true
                 WHERE i2.camp_id = p_camp_id AND jsonb_typeof(i2.camper_names) = 'array'
                   AND jsonb_typeof(i2.person_ids) = 'array'
                   AND i2.person_ids @> to_jsonb(ARRAY[p_person_id])
                 GROUP BY i2.id) x
         WHERE i.id = x.id;
    END IF;

    -- ── the saved documents ──────────────────────────────────────────────────
    FOR d IN
        SELECT key, value FROM camp_state_kv
         WHERE camp_id = p_camp_id
           AND key NOT IN ('campistryMeFinance', 'campistryMePayroll')
         FOR UPDATE
    LOOP
        v_new := public._scrub_person_json(d.value, p_person_id, v_scrub);
        IF v_new IS DISTINCT FROM d.value THEN
            v_docs := v_docs || d.key;
            IF p_confirm THEN
                UPDATE camp_state_kv SET value = v_new, updated_at = now()
                 WHERE camp_id = p_camp_id AND key = d.key;
            END IF;
        END IF;
    END LOOP;

    IF NOT p_confirm THEN
        RETURN jsonb_build_object('success', true, 'dry_run', true,
            'camper', v_p.source_key, 'camperId', p_person_id,
            'would_delete', v_deleted, 'would_detach_money', v_detach,
            'invitations', v_inv, 'documents', to_jsonb(v_docs), 'files', v_files,
            'name_shared_with_an_enrolled_camper', v_scrub IS NULL,
            'to_erase', 'SELECT public.erase_camper(''' || p_camp_id || '''::uuid, '
                     || p_person_id || ', true);');
    END IF;

    -- ── and the identity itself: the number is free ─────────────────────────
    DELETE FROM camp_people WHERE camp_id = p_camp_id AND person_id = p_person_id;

    RETURN jsonb_build_object('success', true, 'erased', true,
        'camper', v_p.source_key, 'camperId', p_person_id,
        'deleted', v_deleted, 'detached_money', v_detach,
        'invitations', v_inv, 'documents', to_jsonb(v_docs), 'files_queued', v_files,
        'name_shared_with_an_enrolled_camper', v_scrub IS NULL,
        'number_is_free', true);
END;
$$;
REVOKE ALL ON FUNCTION public.erase_camper(uuid, bigint, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.erase_camper(uuid, bigint, boolean) TO authenticated, service_role;


-- ─── the departed, still holding numbers ────────────────────────────────────
-- For the office: who has left the roster but not been erased, and what their
-- canteen account holds (an erase needs that at zero).
CREATE OR REPLACE FUNCTION public.list_departed_campers(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
BEGIN
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public._is_camp_admin(p_camp_id, auth.uid()) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    RETURN jsonb_build_object('success', true, 'campers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'camperId', p.person_id, 'name', p.source_key, 'departedAt', p.deleted_at,
                   'canteenBalance', COALESCE((SELECT sum(a.balance) FROM camp_canteen_accounts a
                                                WHERE a.camp_id = p.camp_id AND a.person_id = p.person_id), 0))
                 ORDER BY p.deleted_at DESC)
          FROM camp_people p
         WHERE p.camp_id = p_camp_id AND p.kind = 'camper' AND p.deleted_at IS NOT NULL), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.list_departed_campers(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_departed_campers(uuid) TO authenticated, service_role;


-- ─── the files queue, for the edge function ─────────────────────────────────
-- Returns and clears this camp's queued files. The service role only: the
-- erase-camper-files function checks the caller is the camp's admin first.
CREATE OR REPLACE FUNCTION public.take_erased_files(p_camp_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH gone AS (DELETE FROM camp_erased_files WHERE camp_id = p_camp_id RETURNING bucket, path)
    SELECT jsonb_build_object('success', true, 'files',
           COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'path', path)) FROM gone), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.take_erased_files(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_erased_files(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.is_camp_admin(p_camp_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$ SELECT public._is_camp_admin(p_camp_id, p_user_id) $$;
REVOKE ALL ON FUNCTION public.is_camp_admin(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_camp_admin(uuid, uuid) TO service_role;


-- ─── merging a duplicate: the history goes to the camper who stays ──────────
-- The Me page's "merge duplicate campers" keeps entry A and deletes entry B.
-- B's number then departs holding B's history, which is not erasing (that
-- would throw the history away) and not a camper leaving. This moves every
-- row on B's number onto A's, then deletes B's identity, freeing the number.
-- Refused, with nothing moved, if both numbers hold a canteen account: which
-- balance is the camper's is a person's decision, as in 237.
CREATE OR REPLACE FUNCTION public.merge_campers(p_camp_id uuid, p_keep bigint, p_gone bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_claims text := NULLIF(current_setting('request.jwt.claims', true), '');
    v_keep   camp_people%ROWTYPE;
    v_gone   camp_people%ROWTYPE;
    v_moved  jsonb;
BEGIN
    IF v_claims IS NOT NULL
       AND COALESCE(v_claims::jsonb ->> 'role', '') <> 'service_role'
       AND NOT public._is_camp_admin(p_camp_id, auth.uid()) THEN
        RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
    SELECT * INTO v_keep FROM camp_people WHERE camp_id = p_camp_id AND person_id = p_keep AND kind = 'camper';
    SELECT * INTO v_gone FROM camp_people WHERE camp_id = p_camp_id AND person_id = p_gone AND kind = 'camper';
    IF v_keep.person_id IS NULL OR v_gone.person_id IS NULL OR p_keep = p_gone THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_such_camper');
    END IF;
    IF v_keep.deleted_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'kept_camper_not_enrolled');
    END IF;
    IF v_gone.deleted_at IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'still_enrolled',
            'detail', v_gone.source_key || ' is still on the roster.');
    END IF;
    BEGIN
        v_moved := public._move_person_references(p_camp_id, p_gone, p_keep);
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', 'both_have_canteen_accounts',
            'detail', SQLERRM);
    END;
    -- Invitations name people by position; carry those too.
    UPDATE link_parent_invites
       SET person_ids = (SELECT jsonb_agg(CASE WHEN e.value = to_jsonb(p_gone) THEN to_jsonb(p_keep) ELSE e.value END
                                          ORDER BY e.ord)
                           FROM jsonb_array_elements(person_ids) WITH ORDINALITY e(value, ord))
     WHERE camp_id = p_camp_id AND jsonb_typeof(person_ids) = 'array'
       AND person_ids @> to_jsonb(ARRAY[p_gone]);
    DELETE FROM camp_people WHERE camp_id = p_camp_id AND person_id = p_gone;
    RETURN jsonb_build_object('success', true, 'kept', p_keep, 'freed', p_gone, 'moved', v_moved);
END;
$$;
REVOKE ALL ON FUNCTION public.merge_campers(uuid, bigint, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.merge_campers(uuid, bigint, bigint) TO authenticated, service_role;
