-- ============================================================================
-- 219 — the canteen becomes rows, and the camp-wide lock goes
--
-- ⚠ DO NOT PASTE THIS YET. It is a COUPLED release: campistry_snacks.js must
--   ship in the same deploy. See "THE CLIENT MOVES WITH IT" below. Applying
--   this alone leaves the POS reading balances frozen at the moment it ran.
--
-- WHAT IS WRONG TODAY. Every canteen writer does the same thing:
--
--     SELECT value ... WHERE key = 'campistrySnacks' FOR UPDATE;   -- the camp
--     ... change ONE camper's account inside the document ...
--     UPDATE camp_state_kv SET value = <the whole document>;
--
-- so every sale in a camp queues behind every other one, whoever it belongs
-- to. Measured: ~42 sales a second, camp-wide, and adding registers cannot
-- raise it because the lock is held per sale.
--
-- WHY A MIRROR CANNOT FIX IT. The obvious gentler plan — write rows AND keep
-- the document updated, so no client has to change — does not work, and the
-- reason is the whole point: writing the document IS the lock. jsonb_set on
-- accounts → <name> means UPDATE camp_state_kv on the camp's one row. Keeping
-- the mirror keeps the ceiling exactly where it is.
--
-- WHY THE LEDGER MOVES TOO. submit_canteen_purchase appends to the document's
-- `transactions` array in the same statement. That is the same camp-wide lock
-- under a different name, so balances and ledger are inseparable here.
-- canteen_transactions (203) stops being a projection of the document and
-- becomes the ledger itself.
--
-- WHY ALL THIRTEEN WRITERS AT ONCE. 217's trigger diffs per key, so a writer
-- still on the document cannot clobber an account it does not touch. But the
-- moment one account is purchased (rows) and topped up (document), the deposit
-- reads a stale balance and writes it back through the trigger, and the
-- purchases in between are gone. Mixed truth is only safe if no account is
-- ever written by both regimes — which deposits and purchases violate by
-- definition.
--
-- THE CLIENT MOVES WITH IT. campistry_snacks.js reads camp_state_kv directly
-- (:306, :1668) and writes the whole document back with a compare-and-set
-- (:1773). After this file:
--   * that compare-and-set must stop carrying `accounts` and `transactions`,
--     or it will push a stale snapshot over live balances;
--   * account reads must go through get_canteen_accounts, which 218 already
--     made row-backed.
-- The document keeps its other branches — inventory, POS config — and
-- record_canteen_sale_inventory is deliberately left alone, because it never
-- touches accounts.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql. Requires 216, 217, 218.
-- ============================================================================

-- ─── 0. the safety catch ────────────────────────────────────────────────────
-- This file is INCOMPLETE: the helpers and the projection drops are here, the
-- thirteen writers are not. That combination — writers still updating the
-- document, nothing projecting the document into the rows any more — is the
-- one state in this whole migration chain that loses money silently.
--
-- A header saying "do not paste" is not a safeguard; it is a hope. So the file
-- refuses. Delete this block when the writers land, and not before.
DO $$
BEGIN
    RAISE EXCEPTION E'219 is not finished.\n'
        '  The helpers and the projection drops are written; the thirteen '
        'writers are not converted yet.\n'
        '  Applying it now would leave every writer updating the document '
        'while nothing copies the document into the rows — so balances would '
        'diverge with no error anywhere.\n'
        '  Nothing has been changed. Wait for the completed file.';
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_canteen_accounts') THEN
        RAISE EXCEPTION 'camp_canteen_accounts is missing — apply 217 before this file';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = '_canteen_account_json') THEN
        RAISE EXCEPTION '_canteen_account_json is missing — apply 218 before this file';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- ─── 1. lock ONE account ────────────────────────────────────────────────────
-- The replacement for `SELECT value ... FOR UPDATE` on the whole document.
--
-- Returns the account as the same jsonb object the writers already manipulate,
-- so every writer's money arithmetic stays byte-for-byte what it was — the
-- only thing that changes is what was locked to get it. Two campers at two
-- registers now contend with nobody.
--
-- Creates the row if it is missing, because a camper's first purchase or first
-- deposit legitimately arrives before any account exists. That mirrors the
-- INSERT ... ON CONFLICT DO NOTHING every writer does today against the
-- document.
--
-- WHY IT RETURNS jsonb AND NOT THE ROW: the writers read and write
-- v_acct->>'balance', v_acct->>'dailyLimit' and so on, including fields with
-- no column at all (autoReload, byop handles). Handing back the row would
-- force thirteen functions to be rewritten rather than re-pointed, and every
-- rewrite is a chance to change a number.
CREATE OR REPLACE FUNCTION public.canteen_account_lock(p_camp_id uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_row camp_canteen_accounts;
BEGIN
    IF p_camp_id IS NULL OR p_key IS NULL OR btrim(p_key) = '' THEN
        RETURN NULL;
    END IF;

    INSERT INTO camp_canteen_accounts (camp_id, account_key, person_id, camper_name, payload)
    VALUES (p_camp_id, p_key,
            public._attribute_canteen_account(p_camp_id, p_key),
            p_key, '{}'::jsonb)
    ON CONFLICT (camp_id, account_key) DO NOTHING;

    -- THE lock, and the whole point of the file: one camper's row, not the
    -- camp's document.
    SELECT * INTO v_row FROM camp_canteen_accounts
     WHERE camp_id = p_camp_id AND account_key = p_key
     FOR UPDATE;

    IF NOT FOUND THEN RETURN NULL; END IF;

    -- A stamped account coming back to life: somebody is putting money on it
    -- again, so it is present again. Absence was recorded, not obeyed.
    IF v_row.deleted_at IS NOT NULL THEN
        UPDATE camp_canteen_accounts SET deleted_at = NULL, updated_at = now()
         WHERE camp_id = p_camp_id AND account_key = p_key;
    END IF;

    RETURN public._canteen_account_json(v_row);
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_lock(uuid, text) FROM public, anon, authenticated;


-- ─── 2. save it back ────────────────────────────────────────────────────────
-- The replacement for jsonb_set(v_value, ARRAY['accounts', name], ...) plus
-- the UPDATE of the whole document.
--
-- Columns are extracted from the object so the reader, the verifier and any
-- future query can use them; the object itself is kept in payload so fields
-- with no column survive untouched. _canteen_account_json layers the columns
-- back over the payload on the way out, which is what makes the columns
-- authoritative rather than merely a copy.
--
-- NOTE the limits are stored as NULL when absent, NOT as 0. An absent
-- dailyLimit means the writer's default of 10; a dailyLimit of 0 means no cap
-- at all (submit_canteen_purchase: `IF v_daily > 0 AND ...`). Coalescing would
-- turn a capped camper into an uncapped one.
CREATE OR REPLACE FUNCTION public.canteen_account_save(p_camp_id uuid, p_key text, p_acct jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    UPDATE camp_canteen_accounts SET
        balance       = COALESCE(NULLIF(p_acct ->> 'balance', '')::numeric, 0),
        daily_limit   = NULLIF(p_acct ->> 'dailyLimit',   '')::numeric,
        credit_limit  = NULLIF(p_acct ->> 'creditLimit',  '')::numeric,
        balance_floor = NULLIF(p_acct ->> 'balanceFloor', '')::numeric,
        spent_today   = COALESCE(NULLIF(p_acct ->> 'spentToday', '')::numeric, 0),
        spent_on      = NULLIF(p_acct ->> 'lastSpendDate', '')::date,
        payload       = p_acct,
        deleted_at    = NULL,
        updated_at    = now()
     WHERE camp_id = p_camp_id AND account_key = p_key;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_save(uuid, text, jsonb) FROM public, anon, authenticated;


-- ─── 3. post to the ledger ──────────────────────────────────────────────────
-- The replacement for prepending to the document's `transactions` array.
--
-- canteen_transactions has been a PROJECTION of that array since 203. This
-- makes it the ledger, which is why 206's projection trigger is dropped below:
-- with both in place, a document save would re-derive rows that are now
-- written directly, and the archive would grow a duplicate of every sale.
--
-- sig is the archive's primary key and was computed from the client's own
-- _txSig. A row written here has no document entry to derive one from, so it
-- gets a synthetic signature that cannot collide with a derived one — and the
-- PK still makes a double-post impossible if a writer is retried.
CREATE OR REPLACE FUNCTION public.canteen_post(
    p_camp_id uuid,
    p_key     text,
    p_tx      jsonb,
    p_sig     text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_sig text := COALESCE(p_sig,
        'row:' || encode(digest(p_camp_id::text || '|' || p_key || '|' || p_tx::text
                                || '|' || clock_timestamp()::text, 'sha256'), 'hex'));
BEGIN
    INSERT INTO canteen_transactions
        (camp_id, sig, camper, camper_id, tx_type, amount, tx_date, tx_time, items, payload)
    VALUES (
        p_camp_id, v_sig,
        p_key,
        (SELECT person_id::text FROM camp_canteen_accounts
          WHERE camp_id = p_camp_id AND account_key = p_key),
        COALESCE(p_tx ->> 'type', ''),
        COALESCE(NULLIF(p_tx ->> 'amount', '')::numeric, 0),
        COALESCE(p_tx ->> 'date', (now() AT TIME ZONE 'utc')::date::text),
        COALESCE(p_tx ->> 'time', ''),
        COALESCE(p_tx ->> 'items', ''),
        p_tx)
    ON CONFLICT (camp_id, sig) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_post(uuid, text, jsonb, text) FROM public, anon, authenticated;


-- ─── 4. the projections stop ────────────────────────────────────────────────
-- 217's trigger copies document → account rows, and 203/206's copies document
-- → ledger rows. Both ran in the right direction while the document was the
-- truth. From here the rows ARE the truth, so leaving either in place means a
-- document write — including the client's compare-and-set — can push a stale
-- snapshot over live balances. That is the money-losing path this file exists
-- to close, so they go.
DROP TRIGGER IF EXISTS trg_project_canteen_accounts ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_canteen_archive          ON public.camp_state_kv;
DROP TRIGGER IF EXISTS trg_project_canteen_tx       ON public.camp_state_kv;


-- ─── did it work? ───────────────────────────────────────────────────────────
-- NOTE: this file is INCOMPLETE as it stands — the thirteen writers are
-- converted in the section that follows in the finished migration. Applying it
-- now would leave the writers on the document with the projection triggers
-- gone, which is the one combination that silently loses money.
SELECT 'migration 219 foundation — NOT READY TO APPLY'                      AS status,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND p.proname IN ('canteen_account_lock','canteen_account_save','canteen_post')) AS helpers,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prokind = 'f'
           AND pg_get_functiondef(p.oid) ~ 'campistrySnacks''[^;]*FOR UPDATE')              AS writers_still_locking_the_camp;
