-- ============================================================================
-- Migration 265: a Zelle / bank-transfer payment reaches the family's ledger.
--
-- Standalone. Paste into the Supabase SQL Editor and click Run. Safe to run
-- more than once.
--
-- ── THE PROBLEM (TED-077) ──────────────────────────────────────────────────
-- Bank deposits (Zelle, ACH — read from the bank's alert emails) live in the
-- bank_deposits table. When one is posted to a family, nothing put it on that
-- family's LEDGER, and the ledger is what the office's Billing, the parent's
-- balance and autopay all read once a family has one. A family that paid $400
-- by Zelle on a $1,000 bill still showed $1,000, and autopay collected $500 +
-- $500 — $1,400 in all. (sync_family_ledger_payments, 178/215, can post them,
-- but nothing calls it.)
--
-- ── THE CHANGE ─────────────────────────────────────────────────────────────
-- A trigger on bank_deposits keeps each family's ledger equal to what the
-- deposit table says, whatever changed it — the email reader posting it, the
-- office matching or re-matching it, ignoring it, a bank return:
--   * what the ledger holds for a deposit is the sum of its entries tagged
--     source.depositId (payment +, refund −);
--   * what it should hold is the amount (negative for a return) when the
--     deposit is 'posted' to THIS family, else nothing;
--   * the difference is posted — first as le_dep_<id> (the id
--     sync_family_ledger_payments uses, so the two never double up), later as
--     le_depadj_<id>_<n>. Nothing when they already agree.
-- A family with no ledger yet is left alone (its balance is still derived, and
-- that already counts deposits). An entry the 171 conversion wrote for the
-- deposit (no id; matched by family_covers_deposit) counts as posted.
--
-- Every deposit already posted is brought into line once, at the end.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sync_deposit_to_ledger(p_camp_id uuid, p_family_key text, p_dep_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_fam     jsonb;
    v_entries jsonb;
    d         record;
    v_target  numeric := 0;
    v_net     numeric := 0;
    v_n       integer := 0;
    v_diff    numeric;
    v_date    text;
    e         jsonb;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(p_family_key, '') = '' OR p_dep_id IS NULL THEN RETURN; END IF;
    SELECT id, amount_cents, is_reversal, status, family_key, deposit_date, created_at
      INTO d FROM bank_deposits WHERE id = p_dep_id;

    v_fam := public.camp_family_for_update(p_camp_id, p_family_key);
    IF v_fam IS NULL OR jsonb_typeof(v_fam) <> 'object' THEN RETURN; END IF;
    v_entries := CASE WHEN jsonb_typeof(v_fam->'entries') = 'array' THEN v_fam->'entries' ELSE '[]'::jsonb END;
    IF jsonb_array_length(v_entries) = 0 THEN RETURN; END IF;       -- no ledger yet

    IF d.id IS NOT NULL AND d.status = 'posted' AND d.family_key = p_family_key THEN
        v_target := ROUND(ABS(d.amount_cents::numeric) / 100, 2)
                    * CASE WHEN d.is_reversal THEN -1 ELSE 1 END;
    END IF;
    v_date := COALESCE(to_char(d.deposit_date, 'YYYY-MM-DD'), to_char(d.created_at, 'YYYY-MM-DD'),
                       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'));

    FOR e IN SELECT * FROM jsonb_array_elements(v_entries) LOOP
        IF e->'source'->>'depositId' = p_dep_id::text OR e->>'id' = 'le_dep_' || p_dep_id::text THEN
            v_n := v_n + 1;
            v_net := v_net + CASE e->>'kind'
                WHEN 'payment' THEN COALESCE((e->>'amount')::numeric, 0)
                WHEN 'refund'  THEN -COALESCE((e->>'amount')::numeric, 0)
                ELSE 0 END;
        END IF;
    END LOOP;
    -- The 171 conversion posted deposits with no id: one it covers is posted.
    IF v_n = 0 AND v_target <> 0 AND d.id IS NOT NULL
       AND public.family_covers_deposit(v_fam, d.id, ABS(v_target), v_date) THEN
        RETURN;
    END IF;

    v_diff := ROUND(v_target - v_net, 2);
    IF v_diff = 0 THEN RETURN; END IF;

    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'id',       CASE WHEN v_n = 0 THEN 'le_dep_' || p_dep_id::text
                         ELSE 'le_depadj_' || p_dep_id::text || '_' || v_n END,
        'kind',     CASE WHEN v_diff > 0 THEN 'payment' ELSE 'refund' END,
        'amount',   ABS(v_diff),
        'reason',   CASE WHEN v_diff > 0 THEN 'zelle' ELSE 'reversal' END,
        'date',     v_date,
        'postedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'note',     CASE WHEN v_target = 0 THEN 'Bank deposit no longer on this account'
                         WHEN v_diff < 0 THEN 'Bank deposit reversed'
                         ELSE 'Bank deposit' END,
        'by',       'system',
        'source',   jsonb_build_object('depositId', p_dep_id::text)));
    PERFORM public.camp_family_save(p_camp_id, p_family_key, jsonb_set(v_fam, '{entries}', v_entries, true));
END;
$$;
REVOKE ALL ON FUNCTION public._sync_deposit_to_ledger(uuid, text, uuid) FROM public, anon, authenticated;


CREATE OR REPLACE FUNCTION public._bank_deposit_to_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.family_key IS NOT NULL THEN
        PERFORM public._sync_deposit_to_ledger(OLD.camp_id, OLD.family_key, OLD.id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.family_key IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.family_key IS DISTINCT FROM OLD.family_key
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
            OR NEW.is_reversal IS DISTINCT FROM OLD.is_reversal
            OR OLD.family_key IS NULL) THEN
        PERFORM public._sync_deposit_to_ledger(NEW.camp_id, NEW.family_key, NEW.id);
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._bank_deposit_to_ledger() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bank_deposit_to_ledger ON public.bank_deposits;
CREATE TRIGGER trg_bank_deposit_to_ledger
AFTER INSERT OR UPDATE OF status, family_key, amount_cents, is_reversal OR DELETE
ON public.bank_deposits
FOR EACH ROW EXECUTE FUNCTION public._bank_deposit_to_ledger();

-- Every deposit already posted to a family with a ledger, once.
DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT id, camp_id, family_key FROM bank_deposits
              WHERE status = 'posted' AND family_key IS NOT NULL LOOP
        PERFORM public._sync_deposit_to_ledger(r.camp_id, r.family_key, r.id);
    END LOOP;
END $$;
