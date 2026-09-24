-- ============================================================================
-- Migration 242: sales rung up on an offline register reach the ledger.
--
-- THE DEFECT. The offline register (campistry_snacks_pos_offline.html) keeps
-- its own copy of every account, charges against it, and exports a file of the
-- sales it took. The Snacks page imports that file in importOfflinePOSTransactions
-- — and that importer wrote the campistrySnacks DOCUMENT: it unshifted each sale
-- into snacks.transactions, subtracted it from snacks.accounts[name].balance,
-- and called saveSnacksData.
--
-- 219 made the ROWS the truth, and _withoutRowBackedBranches deletes `accounts`
-- and `transactions` from every document write. So the import reported
-- "Imported 212 offline transactions", and none of them went anywhere. The next
-- hydration rebuilt every balance from camp_canteen_accounts, and every camper
-- who bought something while the register was offline got it free. Same defect
-- as 240, for the one writer 240 deliberately left marked as a KNOWN GAP.
--
-- WHY NOT submit_canteen_purchase. Those sales ALREADY HAPPENED. The register
-- checked its own copy of the caps at the till; replaying the sales through the
-- live purchase path would check the caps again, against a balance the day has
-- since moved, and refuse exactly the rows that need recording. A sale that
-- happened is history: it is posted, and the balance follows — even below zero,
-- because the candy has been eaten. A negative balance after an import is the
-- truth about the day, and the office can see it and collect.
--
-- IDEMPOTENT BY THE REGISTER'S OWN ID. Every offline sale carries the id the
-- register generated for it. The ledger row's signature is 'offline:' || that
-- id, checked UNDER THE ACCOUNT LOCK before the balance moves. So the same file
-- imported twice, two people importing it at once, or a file re-exported with
-- overlapping sales, all move each balance exactly once.
--
-- BY CAMPER ID. The export now carries each camper's id and the register stamps
-- it on each sale. When a row has one, the account is the PERSON's, whatever the
-- camper is called now — a camper renamed between export and import is still
-- charged on their own account rather than a new one under the old spelling.
-- Files from registers loaded before this change carry no id; those fall back to
-- the name, as 240's writers do.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, touches
-- no data. Needs 240 (it shares its gate).
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE missing text := '';
BEGIN
    IF to_regprocedure('public._canteen_office_may_edit(uuid)') IS NULL THEN
        missing := missing || ' _canteen_office_may_edit(uuid)'; END IF;
    IF to_regprocedure('public.canteen_account_lock(uuid,text)') IS NULL THEN
        missing := missing || ' canteen_account_lock(uuid,text)'; END IF;
    IF to_regprocedure('public.canteen_account_save(uuid,text,jsonb)') IS NULL THEN
        missing := missing || ' canteen_account_save(uuid,text,jsonb)'; END IF;
    IF to_regprocedure('public.canteen_post(uuid,text,jsonb,text)') IS NULL THEN
        missing := missing || ' canteen_post(uuid,text,jsonb,text)'; END IF;
    IF to_regprocedure('public.canteen_account_key_for(uuid,text)') IS NULL THEN
        missing := missing || ' canteen_account_key_for(uuid,text)'; END IF;
    IF to_regprocedure('public.camp_person_by_name(uuid,text)') IS NULL THEN
        missing := missing || ' camp_person_by_name(uuid,text)'; END IF;
    IF to_regprocedure('public.camp_person_label(uuid,bigint)') IS NULL THEN
        missing := missing || ' camp_person_label(uuid,bigint)'; END IF;
    IF missing <> '' THEN
        RAISE EXCEPTION '242 needs:% — apply 240 first', missing;
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the importer ────────────────────────────────────────────────────────
-- p_rows is the register's own transaction array, as exported:
--   [{ id, camper, camperId?, amount, type, items, date, time, timestamp }, …]
--
-- Returns every row's outcome, so the page can say exactly what happened:
--   { success, imported, duplicates, refused: [{id, camper, error}], campers }
--
-- At most 1000 rows per call. The page sends the file in chunks; a single
-- statement holding a thousand account locks is the ceiling worth having.
CREATE OR REPLACE FUNCTION public.canteen_office_import_offline(
    p_camp_id uuid,
    p_rows    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r          jsonb;
    v_oid      text;
    v_sig      text;
    v_id       bigint;
    v_name     text;
    v_key      text;
    v_amt      numeric;
    v_date     text;
    v_acct     jsonb;
    v_bal      numeric;
    v_spent    numeric;
    v_last     text;
    v_imported int := 0;
    v_dupes    int := 0;
    v_refused  jsonb := '[]'::jsonb;
    v_touched  jsonb := '{}'::jsonb;
BEGIN
    IF NOT public._canteen_office_may_edit(p_camp_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_rows');
    END IF;
    IF jsonb_array_length(p_rows) > 1000 THEN
        RETURN jsonb_build_object('success', false, 'error', 'too_many_rows');
    END IF;

    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
        -- Each row is refused on its own; one bad row does not lose the file.
        v_oid := NULLIF(btrim(COALESCE(r ->> 'id', '')), '');
        IF v_oid IS NULL THEN
            v_refused := v_refused || jsonb_build_object('id', NULL,
                'camper', r ->> 'camper', 'error', 'missing_id');
            CONTINUE;
        END IF;

        -- The register only ever writes debits. Anything else in the file is
        -- not a sale, and guessing what it meant is how money appears.
        IF COALESCE(r ->> 'type', '') <> 'debit' THEN
            v_refused := v_refused || jsonb_build_object('id', v_oid,
                'camper', r ->> 'camper', 'error', 'unsupported_type');
            CONTINUE;
        END IF;

        v_amt := round(COALESCE(NULLIF(r ->> 'amount', '')::numeric, 0), 2);
        -- The same ceiling the live purchase path has on one sale.
        IF v_amt <= 0 OR v_amt > 1000 THEN
            v_refused := v_refused || jsonb_build_object('id', v_oid,
                'camper', r ->> 'camper', 'error', 'invalid_amount');
            CONTINUE;
        END IF;

        v_date := btrim(COALESCE(r ->> 'date', ''));
        IF v_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
            v_refused := v_refused || jsonb_build_object('id', v_oid,
                'camper', r ->> 'camper', 'error', 'invalid_date');
            CONTINUE;
        END IF;

        -- The PERSON first, the spelling only when the file predates ids —
        -- 240's order.
        v_id := NULL;
        IF COALESCE(r ->> 'camperId', '') ~ '^\d+$' THEN
            v_id := (r ->> 'camperId')::bigint;
            v_name := public.camp_person_label(p_camp_id, v_id);
            IF v_name IS NULL THEN
                v_refused := v_refused || jsonb_build_object('id', v_oid,
                    'camper', r ->> 'camper', 'error', 'unknown_camper');
                CONTINUE;
            END IF;
        ELSE
            v_name := NULLIF(btrim(COALESCE(r ->> 'camper', '')), '');
            IF v_name IS NULL THEN
                v_refused := v_refused || jsonb_build_object('id', v_oid,
                    'camper', NULL, 'error', 'missing_camper');
                CONTINUE;
            END IF;
            v_id := public.camp_person_by_name(p_camp_id, v_name);
        END IF;

        v_sig := 'offline:' || v_oid;

        -- Lock, THEN look. Two imports of one file serialize on the account, so
        -- the second one sees the first's row and moves nothing.
        v_acct := public.canteen_account_lock(p_camp_id, v_name);
        IF EXISTS (SELECT 1 FROM canteen_transactions
                    WHERE camp_id = p_camp_id AND sig = v_sig) THEN
            v_dupes := v_dupes + 1;
            CONTINUE;
        END IF;

        v_acct  := COALESCE(v_acct, '{"balance":0,"dailyLimit":10,"spentToday":0}'::jsonb);
        v_bal   := round(COALESCE((v_acct ->> 'balance')::numeric, 0) - v_amt, 2);
        v_spent := COALESCE((v_acct ->> 'spentToday')::numeric, 0);
        v_last  := v_acct ->> 'lastSpendDate';

        -- Today's cap has to know about today's offline sales, or the camper
        -- spends their limit twice: once offline, once again at the live till.
        -- An older sale is history for an older day and moves no counter.
        IF v_last IS NULL OR v_date > v_last THEN
            v_spent := v_amt;
            v_last  := v_date;
        ELSIF v_date = v_last THEN
            v_spent := round(v_spent + v_amt, 2);
        END IF;

        PERFORM public.canteen_account_save(p_camp_id, v_name,
            v_acct || jsonb_build_object('balance', v_bal,
                                         'spentToday', v_spent,
                                         'lastSpendDate', v_last));

        PERFORM public.canteen_post(p_camp_id, v_name,
            jsonb_build_object(
                'time',      COALESCE(r ->> 'time', ''),
                'camper',    v_name,
                'items',     COALESCE(r ->> 'items', ''),
                'amount',    v_amt,
                'type',      'debit',
                'kind',      'offline_sale',
                'offlineId', v_oid,
                'date',      v_date),
            v_sig);

        v_imported := v_imported + 1;
        v_key := public.canteen_account_key_for(p_camp_id, v_name);
        v_touched := v_touched || jsonb_build_object(v_key,
            jsonb_build_object('balance', v_bal, 'camperId', v_id));
    END LOOP;

    RETURN jsonb_build_object(
        'success',    true,
        'imported',   v_imported,
        'duplicates', v_dupes,
        'refused',    v_refused,
        'campers',    v_touched);
END;
$$;

REVOKE ALL ON FUNCTION public.canteen_office_import_offline(uuid, jsonb)
    FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_office_import_offline(uuid, jsonb)
    TO authenticated;


-- ─── 2. the check ───────────────────────────────────────────────────────────
-- Read by scripts/verify_identity_chain.sql. Reports the shape, from the code
-- with comments stripped, so prose describing a rule cannot pass for the rule.
CREATE OR REPLACE FUNCTION public.verify_offline_import()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH b AS (
        SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') AS src
          FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.canteen_office_import_offline(uuid,jsonb)'))
    SELECT jsonb_build_object(
        'present',           EXISTS (SELECT 1 FROM b),
        'gated',             COALESCE((SELECT src ~ '_canteen_office_may_edit' FROM b), false),
        'idempotent_by_sig', COALESCE((SELECT src ~ '''offline:''' AND src ~ 'sig\s*=\s*v_sig' FROM b), false),
        'resolves_by_id',    COALESCE((SELECT src ~ 'camp_person_label' FROM b), false))
$$;
REVOKE ALL ON FUNCTION public.verify_offline_import() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_offline_import() TO authenticated, service_role;

SELECT public.verify_offline_import() AS "242 check — every value should be true";
