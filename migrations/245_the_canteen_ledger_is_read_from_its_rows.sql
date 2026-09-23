-- ============================================================================
-- Migration 245: the canteen ledger is read from its rows.
--
-- THE DEFECT. 219 moved every canteen WRITER onto canteen_transactions (through
-- canteen_post) and left the one READER behind. get_canteen_accounts says so
-- itself, in the comment above its parent branch:
--
--     Still read from the blob: 219 moves the ledger with the writers that
--     fill it.
--
-- It did not. Both branches still return campistrySnacks.transactions, a list
-- nothing has appended to since 219 — and which the page strips from every
-- document save, so on a camp that has saved at all it is empty. Consequences:
--
--   * The Snacks manager's transaction log, the day's revenue and the analytics
--     are all computed from that list. No sale, deposit or cash-out since 219
--     appears in any of them.
--   * A parent opening the portal sees none of their child's purchases or
--     deposits since 219.
--   * The parent branch filtered the list by camper NAME — so after a rename a
--     parent lost sight of their child's history, and a family that inherited a
--     name could have seen somebody else's.
--
-- Balances were never wrong: they are camp_canteen_accounts rows. This is the
-- history, which is how a family or an office checks a balance.
--
-- THE FIX. Both branches read canteen_transactions. And every ACCOUNT now
-- carries its camperId (the row's person_id), because accounts are keyed by
-- account_key and after a rename that is the old spelling: a page looking a
-- camper up by today's name found nothing, and the season close-out reported
-- "no unspent canteen money" for a child whose name had changed. Each row comes back in the
-- shape the page already reads (the payload canteen_post stored) plus camperId —
-- so the page joins sales to a PERSON.
--
--   staff   the last 7 days, newest first, at most 10,000 rows. The page
--           uses today (the log, the day's numbers) and the last seven days
--           (the weekly chart); anything older is one click away through
--           get_canteen_history, which the page's "Show archived history"
--           button already calls. Measured on a 600-camper camp with 36,000
--           ledger rows (tests/scale_600.e2e.js): a 60-day window shipped
--           3.4 MB and took 289 ms on every page load AND after every desk
--           deposit. `ledgerWindow` says where the window starts.
--   parent  every row for their own children, matched by ID, with the
--           unattributed-by-name fallback the accounts use.
--
-- Two indexes for those two reads.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction; one function and two
-- indexes. Moves no data.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regclass('public.canteen_transactions') IS NULL THEN
        RAISE EXCEPTION '245 needs canteen_transactions — apply 203 and 219 first';
    END IF;
    IF to_regprocedure('public.camp_parent_campers(uuid)') IS NULL THEN
        RAISE EXCEPTION '245 needs camp_parent_campers(uuid) — apply 183 first';
    END IF;
    IF to_regprocedure('public.camp_parent_camper_ids(uuid)') IS NULL THEN
        RAISE EXCEPTION '245 needs camp_parent_camper_ids(uuid) — apply 227 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';

CREATE INDEX IF NOT EXISTS idx_canteen_tx_camp_date
    ON public.canteen_transactions (camp_id, tx_date DESC, first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_canteen_tx_camp_person
    ON public.canteen_transactions (camp_id, camper_id);


-- One ledger row as the page reads it: the stored payload, with the columns
-- that are authoritative laid over it.
CREATE OR REPLACE FUNCTION public._canteen_tx_json(t canteen_transactions)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(t.payload, '{}'::jsonb)
        || jsonb_build_object(
               'sig',      t.sig,
               'camper',   COALESCE(NULLIF(t.payload ->> 'camper', ''), t.camper),
               'camperId', t.camper_id,
               'type',     t.tx_type,
               'amount',   t.amount,
               'date',     t.tx_date,
               'time',     t.tx_time,
               'items',    t.items)
$$;
REVOKE ALL ON FUNCTION public._canteen_tx_json(canteen_transactions) FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.get_canteen_accounts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_mine   jsonb;
    v_ids    bigint[];
    v_idtxt  text[];
    v_accts  jsonb := '{}'::jsonb;
    v_txs    jsonb;
    v_from   text := ((now() AT TIME ZONE 'utc')::date - 7)::text;
    v_cap    int  := 10000;
    v_total  bigint;
BEGIN
    -- Staff: the whole camp. Unchanged from 218 except where the ledger comes from.
    IF public.camp_staff_member(p_camp_id) THEN
        SELECT COALESCE(jsonb_object_agg(a.account_key, public._canteen_account_json(a)
                   || CASE WHEN a.person_id IS NULL THEN '{}'::jsonb
                           ELSE jsonb_build_object('camperId', a.person_id) END), '{}'::jsonb)
          INTO v_accts
          FROM camp_canteen_accounts a
         WHERE a.camp_id = p_camp_id AND a.deleted_at IS NULL;

        SELECT COALESCE(jsonb_agg(public._canteen_tx_json(t) ORDER BY t.tx_date DESC, t.first_seen DESC), '[]'::jsonb)
          INTO v_txs
          FROM (SELECT * FROM canteen_transactions
                 WHERE camp_id = p_camp_id AND tx_date >= v_from
                 ORDER BY tx_date DESC, first_seen DESC
                 LIMIT v_cap) t;

        SELECT count(*) INTO v_total FROM canteen_transactions
         WHERE camp_id = p_camp_id AND tx_date >= v_from;

        RETURN jsonb_build_object(
            'success', true,
            'accounts', v_accts,
            'transactions', v_txs,
            'ledgerWindow', jsonb_build_object(
                'from', v_from, 'rows', LEAST(v_total, v_cap), 'truncated', v_total > v_cap));
    END IF;

    v_mine := public.camp_parent_campers(p_camp_id);
    IF jsonb_array_length(v_mine) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
    END IF;

    -- The parent's children as IDS — 227's resolver, which reads the ids 223
    -- stamped on the invite, so a renamed child stays theirs. The NAMES above are
    -- only for accounts and rows that never had an id.
    v_ids := public.camp_parent_camper_ids(p_camp_id);
    SELECT COALESCE(array_agg(x::text), '{}') INTO v_idtxt FROM unnest(v_ids) x;

    SELECT COALESCE(jsonb_object_agg(a.account_key, public._canteen_account_json(a)
                   || CASE WHEN a.person_id IS NULL THEN '{}'::jsonb
                           ELSE jsonb_build_object('camperId', a.person_id) END), '{}'::jsonb)
      INTO v_accts
      FROM camp_canteen_accounts a
     WHERE a.camp_id = p_camp_id
       AND a.deleted_at IS NULL
       AND (
            (a.person_id IS NOT NULL AND a.person_id = ANY (v_ids))
            -- Only for rows with no id: once an account belongs to a child, a
            -- matching NAME must not grant anybody else sight of it.
            OR (a.person_id IS NULL AND v_mine ? a.account_key)
       );

    -- Their children's rows, by id; a row with no id only by the name it was
    -- written under, and only then — the same rule as the accounts above.
    SELECT COALESCE(jsonb_agg(public._canteen_tx_json(t) ORDER BY t.tx_date DESC, t.first_seen DESC), '[]'::jsonb)
      INTO v_txs
      FROM canteen_transactions t
     WHERE t.camp_id = p_camp_id
       AND (   (t.camper_id IS NOT NULL AND t.camper_id = ANY (v_idtxt))
            OR (t.camper_id IS NULL AND v_mine ? t.camper));

    RETURN jsonb_build_object('success', true, 'accounts', v_accts,
                              'transactions', v_txs, 'scope', 'parent');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
REVOKE ALL ON FUNCTION public.get_canteen_accounts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_canteen_accounts(uuid) TO authenticated, service_role;


-- ─── the check ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_canteen_ledger_reader()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    WITH b AS (SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') AS src FROM pg_proc
                WHERE oid = to_regprocedure('public.get_canteen_accounts(uuid)'))
    SELECT jsonb_build_object(
        'reads_the_rows',         (SELECT src ~ 'FROM canteen_transactions' FROM b),
        'reads_the_document',     (SELECT src ~ '''campistrySnacks''' FROM b),
        'parent_matched_by_id',   (SELECT src ~ 'camper_id = ANY' FROM b))
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_ledger_reader() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_ledger_reader() TO authenticated, service_role;

SELECT public.verify_canteen_ledger_reader()
       AS "245 check — reads_the_rows true, reads_the_document false";
