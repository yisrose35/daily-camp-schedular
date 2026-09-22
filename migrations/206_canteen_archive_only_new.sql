-- ════════════════════════════════════════════════════════════════════════════
-- 206 — the canteen archive stops re-archiving the whole history per sale
-- ════════════════════════════════════════════════════════════════════════════
--
-- A REGRESSION 203 INTRODUCED. Migration 203's trigger archived by inserting
-- EVERY transaction in the blob on every write and letting ON CONFLICT DO
-- NOTHING discard the ones already stored. Correct, and O(total transactions)
-- per sale: one signature per historical row, a DISTINCT ON sort over all of
-- them, and — the expensive part — that many index probes and insert conflicts
-- against canteen_transactions.
--
-- Because the archive is append-only by design, it only ever grows, so each
-- sale cost more than the last. Measured with the load test's 100-purchase
-- rush against one camp, same 100 calls each time:
--
--     run 1   p50  429ms   p95   954ms   84 rps
--     run 2   p50  485ms   p95  1044ms   77 rps
--     run 3   p50  965ms   p95  3779ms   26 rps
--
-- Nothing about the camp changed between those runs. The archive got bigger.
--
-- THE FIX: archive only the transactions this write actually added — the ones
-- whose signature is not already in OLD's array. A sale prepends one row, so
-- the steady-state cost becomes one insert instead of N, and it no longer
-- depends on how long the camp has been trading.
--
-- The old sigs are materialised into a jsonb OBJECT and probed with `?`, not
-- collected into an array and probed with `= ANY`. Key lookup in a jsonb object
-- is a binary search over sorted keys, so the pass is O(n log n); `= ANY` over
-- an array is a linear scan per row, which is O(n²) and would have re-created
-- the same shape of problem one layer down.
--
-- WHAT IS DELIBERATELY UNCHANGED:
--   * ON CONFLICT DO NOTHING stays. The diff is an optimisation, not the
--     correctness story — two writers can still race to archive the same row,
--     and the primary key is what makes that safe.
--   * TG_OP = 'INSERT' still archives everything, because there is no OLD to
--     diff against. That is the one genuinely O(n) path, and it runs once per
--     camp.
--   * The append-only rule stays: no updates, no deletes. A transaction
--     vanishing from the blob is exactly the loss this table exists to survive.
--   * canteen_tx_sig, the table, its index, the RPC and the verifier are all
--     untouched — this migration replaces one trigger function body.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only; no data is read or written.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- ─── AFTERWARDS (optional, and only on a throwaway project) ─────────────────
-- Load-test rows inflate the archive permanently. To drop them:
--     DELETE FROM public.canteen_transactions WHERE camper LIKE 'Load Camper %';
-- Never run that against a real camp — `camper` is a display name.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.archive_canteen_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_new     jsonb;
    v_old     jsonb;
    v_oldSigs jsonb;
BEGIN
    -- An inventory or config save still costs exactly one comparison.
    IF TG_OP <> 'INSERT'
       AND (NEW.value -> 'transactions') IS NOT DISTINCT FROM (OLD.value -> 'transactions') THEN
        RETURN NEW;
    END IF;

    v_new := CASE WHEN jsonb_typeof(NEW.value -> 'transactions') = 'array'
                  THEN NEW.value -> 'transactions' ELSE '[]'::jsonb END;

    -- On INSERT there is no prior array, so everything in it is new.
    v_old := CASE WHEN TG_OP = 'INSERT' THEN '[]'::jsonb
                  WHEN jsonb_typeof(OLD.value -> 'transactions') = 'array'
                  THEN OLD.value -> 'transactions'
                  ELSE '[]'::jsonb END;

    -- The sigs already present before this write. jsonb_object_agg tolerates
    -- duplicate keys (last wins), which matters: a blob can legitimately hold
    -- two identical transactions, and they collapse to one archive row anyway
    -- because the signature IS the identity — the same rule the client's
    -- _txSig and 203's verifier both use.
    SELECT COALESCE(jsonb_object_agg(public.canteen_tx_sig(o), true), '{}'::jsonb)
      INTO v_oldSigs
      FROM jsonb_array_elements(v_old) AS o
     WHERE jsonb_typeof(o) = 'object';

    INSERT INTO public.canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    SELECT DISTINCT ON (n.sig)
           NEW.camp_id,
           n.sig,
           COALESCE(n.tx ->> 'camper', ''),
           NULLIF(n.tx ->> 'camperId', ''),
           COALESCE(n.tx ->> 'type', ''),
           COALESCE(public._num_or_null(n.tx ->> 'amount'), 0),
           COALESCE(n.tx ->> 'date', ''),
           COALESCE(n.tx ->> 'time', ''),
           COALESCE(n.tx ->> 'items', ''),
           n.tx
      FROM (SELECT public.canteen_tx_sig(t) AS sig, t AS tx
              FROM jsonb_array_elements(v_new) AS t
             WHERE jsonb_typeof(t) = 'object') AS n
     WHERE NOT (v_oldSigs ? n.sig)
    ON CONFLICT (camp_id, sig) DO NOTHING;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.archive_canteen_transactions() FROM public, anon, authenticated;


-- ─── verify ─────────────────────────────────────────────────────────────────
-- 203's verifier is the check that matters and is unchanged: it compares the
-- archive against the blob and reports anything missing. It takes a camp id and
-- has NO default, so bare parentheses match no function. Run it per camp:
--
--   SELECT c.id AS camp_id, public.verify_canteen_archive(c.id) AS result
--     FROM camps c
--    WHERE EXISTS (SELECT 1 FROM camp_state_kv k
--                   WHERE k.camp_id = c.id AND k.key = 'campistrySnacks');
--
-- inSync:true with missingFromArchive:0 means the narrower trigger still
-- archives everything a sale adds. If a future write path ever bulk-REPLACES
-- the transactions array rather than appending to it, that verifier is what
-- will say so.
