-- ============================================================================
-- 217 — camp_canteen_accounts: one row per camper, keyed on the id
--
-- WHY. Every canteen sale does SELECT ... FOR UPDATE on the camp's ENTIRE
-- campistrySnacks document to change one child's balance, so sales are
-- serialized camp-wide: the measured ceiling is ~42 per second no matter how
-- many registers are open, and adding registers cannot raise it. That is the
-- last place the whole-blob lock survives — payments and families left in
-- 208-215.
--
-- WHAT IT IS KEYED ON. person_id from 216, not the name. The blob keys accounts
-- by camper name (campistrySnacks → accounts → "Chaim Katz"), and this project
-- already shows what that costs: 354 of 803 accounts point at a name the
-- roster can no longer resolve, because the season reset clears camperRoster
-- wholesale (campistry_me.js:21440) while the accounts outlive it.
--
-- WHAT HAPPENS TO THOSE 354. They are kept, with person_id NULL and the name
-- they were filed under, and reported by verify_canteen_accounts(). Some hold
-- real balances — money owed to a child — so they are neither dropped nor
-- guessed onto whichever camper has a similar name. A row nobody can attribute
-- is a question for a human; silently attributing it is how money goes to the
-- wrong family.
--
-- THE BALANCE IS A COLUMN AND THE LEDGER IS ROWS — two sources of truth, which
-- is the shape money bugs come from, and this session has already produced two.
-- It is still right: deriving the balance by SUM on every portal poll is a lot
-- of work per read, and the portal polls every 30 seconds per parent. What
-- makes it acceptable is the third piece — verify_canteen_accounts() proves
-- sum(ledger) = balance for every camper. Without the verifier this design
-- would not be worth having.
--
-- spent_today CARRIES ITS DATE. A daily limit needs a counter that resets at
-- midnight. Stamping it with the day it belongs to means a stale value
-- self-heals on the first read of the next day — no nightly job to fail, and
-- no camper mysteriously refused at the register because a reset did not run.
--
-- WHAT IT DOES NOT DO. Nothing reads these rows and nothing writes them: the
-- blob is still the truth, all 14 writers still take the camp-wide lock, and
-- every function signature is unchanged. 218 switches the readers, 219 moves
-- the writers and removes the lock. Building the rows and flipping the truth
-- in one file would leave no way to tell which half broke.
--
-- HOW TO APPLY. Paste the whole file into the Supabase SQL Editor. One
-- transaction; idempotent; re-running converges and doubles as the repair tool.
-- Requires 216.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

-- ─── 0. preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'camp_people') THEN
        RAISE EXCEPTION 'camp_people is missing — apply 216 before this file';
    END IF;
END $$;

-- Same lock ordering as 216, and for the same reason — see that file's section
-- 0b. This one is MORE exposed, not less: its trigger fires on campistrySnacks,
-- which is rewritten on every single canteen sale, so the window where a live
-- writer holds camp_state_kv and wants camp_canteen_accounts is open all day
-- rather than only when somebody edits a roster. 216 deadlocked on the first
-- live paste; there is no reason to let this one find that out again.
SET LOCAL lock_timeout = '15s';
LOCK TABLE public.camp_state_kv IN ACCESS EXCLUSIVE MODE;


-- ─── 1. the table ───────────────────────────────────────────────────────────
-- account_key is the document's own key (the camper's name today), kept as the
-- bridge back to the blob for as long as the blob exists. person_id is the
-- identity. The primary key is (camp_id, account_key) rather than person_id
-- because the 354 unattributable accounts have no person_id and must still be
-- stored — the id is the identity we are moving TO, not a precondition for
-- recording what is already there.
CREATE TABLE IF NOT EXISTS public.camp_canteen_accounts (
    camp_id       uuid    NOT NULL,
    account_key   text    NOT NULL,
    person_id     bigint,                    -- NULL = could not be attributed
    camper_name   text    NOT NULL DEFAULT '',
    balance       numeric NOT NULL DEFAULT 0,
    daily_limit   numeric,
    credit_limit  numeric,
    balance_floor numeric,
    spent_today   numeric NOT NULL DEFAULT 0,
    -- The day spent_today belongs to. See the header: a counter that carries
    -- its own date needs no nightly reset and cannot lock a camper out because
    -- a job did not run.
    spent_on      date,
    payload       jsonb   NOT NULL DEFAULT '{}'::jsonb,
    deleted_at    timestamptz,
    first_seen    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (camp_id, account_key)
);

-- The lookup 218/219 will do on every sale and every portal read. Partial,
-- because an unattributable account is never the target of a sale.
CREATE UNIQUE INDEX IF NOT EXISTS uq_canteen_accounts_person
    ON public.camp_canteen_accounts (camp_id, person_id)
    WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_canteen_accounts_live
    ON public.camp_canteen_accounts (camp_id) WHERE deleted_at IS NULL;

ALTER TABLE public.camp_canteen_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camp_canteen_accounts FROM anon, authenticated;

COMMENT ON TABLE public.camp_canteen_accounts IS
    'One row per canteen account, identified by camp_people.person_id. Replaces campistrySnacks.accounts, whose camp-wide lock serialized every sale in a camp. person_id NULL means the blob key could not be attributed to a camper — kept, never guessed. Deny-all; reads go through gated RPCs.';


-- ─── 2. attribution ─────────────────────────────────────────────────────────
-- The blob's key is a camper NAME. Turning it into an id is the whole job of
-- this migration, and it must be done the same way every time it runs, so the
-- rules are explicit and ordered:
--
--   1. the live roster key, exactly — the normal case;
--   2. the same key ignoring case and surrounding space, because "Chaim Katz "
--      and "chaim katz" are the same child and the blob has both;
--   3. a person who has since been stamped deleted but whose key still matches
--      — last season's camper, whose balance is still theirs;
--   4. otherwise NULL.
--
-- What it deliberately will NOT do is match on a similar name, a first name,
-- or a single remaining candidate. Attributing a balance to the wrong child is
-- worse than leaving it unattributed, because unattributed is visible and
-- misattributed is not.
CREATE OR REPLACE FUNCTION public._attribute_canteen_account(p_camp_id uuid, p_key text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT person_id FROM (
        SELECT person_id, 1 AS rank FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND deleted_at IS NULL AND source_key = p_key
        UNION ALL
        SELECT person_id, 2 FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND deleted_at IS NULL AND lower(btrim(source_key)) = lower(btrim(p_key))
        UNION ALL
        SELECT person_id, 3 FROM camp_people
         WHERE camp_id = p_camp_id AND kind = 'camper'
           AND lower(btrim(source_key)) = lower(btrim(p_key))
    ) c ORDER BY rank LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._attribute_canteen_account(uuid, text)
    FROM public, anon, authenticated;


-- ─── 3. the trigger that keeps it true ──────────────────────────────────────
-- Diffed against OLD, for the reason 206 exists: the snacks document is
-- rewritten on every single sale, and a trigger that re-derived every account
-- per sale is exactly the decay that took the canteen from 84 to 26 sales per
-- second before 206 fixed it. This one touches only accounts that changed.
CREATE OR REPLACE FUNCTION public.project_canteen_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
    r     record;
BEGIN
    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.value -> 'accounts') = 'object' THEN
        v_old := OLD.value -> 'accounts';
    END IF;
    IF jsonb_typeof(NEW.value -> 'accounts') = 'object' THEN
        v_new := NEW.value -> 'accounts';
    END IF;

    FOR r IN
        SELECT n.key AS k, n.value AS v
          FROM jsonb_each(v_new) AS n(key, value)
         WHERE jsonb_typeof(n.value) = 'object'
           AND (v_old -> n.key) IS DISTINCT FROM n.value
    LOOP
        INSERT INTO camp_canteen_accounts AS a
            (camp_id, account_key, person_id, camper_name, balance,
             daily_limit, credit_limit, balance_floor, spent_today, spent_on, payload)
        VALUES (
            NEW.camp_id, r.k,
            public._attribute_canteen_account(NEW.camp_id, r.k),
            r.k,
            COALESCE(NULLIF(r.v ->> 'balance', '')::numeric, 0),
            NULLIF(r.v ->> 'dailyLimit',   '')::numeric,
            NULLIF(r.v ->> 'creditLimit',  '')::numeric,
            NULLIF(r.v ->> 'balanceFloor', '')::numeric,
            COALESCE(NULLIF(r.v ->> 'spentToday', '')::numeric, 0),
            NULLIF(r.v ->> 'spentOn', '')::date,
            r.v)
        ON CONFLICT (camp_id, account_key) DO UPDATE
           SET balance       = EXCLUDED.balance,
               daily_limit   = EXCLUDED.daily_limit,
               credit_limit  = EXCLUDED.credit_limit,
               balance_floor = EXCLUDED.balance_floor,
               spent_today   = EXCLUDED.spent_today,
               spent_on      = EXCLUDED.spent_on,
               payload       = EXCLUDED.payload,
               camper_name   = EXCLUDED.camper_name,
               -- Re-attribute only while unattributed. Once a balance belongs
               -- to a child it stays theirs: a later roster edit that happens
               -- to free up a name must never move somebody's money.
               person_id     = COALESCE(a.person_id, EXCLUDED.person_id),
               deleted_at    = NULL,
               updated_at    = now();
    END LOOP;

    -- Gone from the document → stamped, never destroyed. A canteen account is
    -- money; absence is recorded and left for a human, the same rule 211 uses
    -- for families and 208 for payments.
    UPDATE camp_canteen_accounts a
       SET deleted_at = now(), updated_at = now()
     WHERE a.camp_id = NEW.camp_id
       AND a.deleted_at IS NULL
       AND NOT (v_new ? a.account_key);

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_canteen_accounts() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_canteen_accounts ON public.camp_state_kv;
CREATE TRIGGER trg_project_canteen_accounts
AFTER INSERT OR UPDATE ON public.camp_state_kv
FOR EACH ROW
WHEN (NEW.key = 'campistrySnacks')
EXECUTE FUNCTION public.project_canteen_accounts();


-- ─── 4. the backfill ────────────────────────────────────────────────────────
-- A function, not a bare block, for the reason 216 learned: the header calls it
-- a repair tool, and a block pasted once is not a tool anybody can reach. It is
-- also how attribution gets re-run after somebody fixes a roster, which is the
-- expected remedy for the 354.
CREATE OR REPLACE FUNCTION public.backfill_canteen_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_rows integer;
    v_attr integer;
BEGIN
    INSERT INTO public.camp_canteen_accounts AS a
        (camp_id, account_key, person_id, camper_name, balance,
         daily_limit, credit_limit, balance_floor, spent_today, spent_on, payload)
    SELECT kv.camp_id, ac.key,
           public._attribute_canteen_account(kv.camp_id, ac.key),
           ac.key,
           COALESCE(NULLIF(ac.value ->> 'balance', '')::numeric, 0),
           NULLIF(ac.value ->> 'dailyLimit',   '')::numeric,
           NULLIF(ac.value ->> 'creditLimit',  '')::numeric,
           NULLIF(ac.value ->> 'balanceFloor', '')::numeric,
           COALESCE(NULLIF(ac.value ->> 'spentToday', '')::numeric, 0),
           NULLIF(ac.value ->> 'spentOn', '')::date,
           ac.value
      FROM camp_state_kv kv
      CROSS JOIN LATERAL jsonb_each(
             CASE WHEN jsonb_typeof(kv.value -> 'accounts') = 'object'
                  THEN kv.value -> 'accounts' ELSE '{}'::jsonb END) AS ac(key, value)
     WHERE kv.key = 'campistrySnacks'
       AND jsonb_typeof(ac.value) = 'object'
       AND EXISTS (SELECT 1 FROM camps c WHERE c.id = kv.camp_id)
    ON CONFLICT (camp_id, account_key) DO UPDATE
       SET balance       = EXCLUDED.balance,
           daily_limit   = EXCLUDED.daily_limit,
           credit_limit  = EXCLUDED.credit_limit,
           balance_floor = EXCLUDED.balance_floor,
           spent_today   = EXCLUDED.spent_today,
           spent_on      = EXCLUDED.spent_on,
           payload       = EXCLUDED.payload,
           person_id     = COALESCE(a.person_id, EXCLUDED.person_id),
           updated_at    = now();
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    SELECT count(*) INTO v_attr
      FROM camp_canteen_accounts WHERE person_id IS NULL AND deleted_at IS NULL;

    RETURN jsonb_build_object('accountRows', v_rows, 'stillUnattributed', v_attr);
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_canteen_accounts() FROM public, anon, authenticated;

SELECT public.backfill_canteen_accounts();


-- ─── 5. the verifier ────────────────────────────────────────────────────────
-- Two independent questions, and the second is the one that makes a stored
-- balance column safe to have at all:
--
--   does every account in the blob have a row, with the same balance?
--   does the LEDGER agree with the balance, camper by camper?
--
-- canteen_transactions (203/206) is the ledger. It is a projection of the same
-- blob today, so agreement is expected now and becomes load-bearing in 219
-- when the rows become the truth and the two can genuinely drift.
CREATE OR REPLACE FUNCTION public.verify_canteen_accounts(p_camp_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_blob     jsonb;
    v_in_blob  integer;
    v_in_rows  integer;
    v_missing  text[];
    v_mismatch jsonb;
    v_unattr   jsonb;
BEGIN
    IF NOT public.camp_reader(p_camp_id) THEN
        RETURN jsonb_build_object('error', 'not_your_camp');
    END IF;

    SELECT CASE WHEN jsonb_typeof(value -> 'accounts') = 'object'
                THEN value -> 'accounts' ELSE '{}'::jsonb END
      INTO v_blob FROM camp_state_kv WHERE camp_id = p_camp_id AND key = 'campistrySnacks';
    v_blob := COALESCE(v_blob, '{}'::jsonb);

    v_in_blob := (SELECT count(*) FROM jsonb_each(v_blob) e WHERE jsonb_typeof(e.value) = 'object');
    SELECT count(*) INTO v_in_rows
      FROM camp_canteen_accounts WHERE camp_id = p_camp_id AND deleted_at IS NULL;

    -- Named, not counted. A count that happens to match says nothing about
    -- WHICH account is missing, and the missing one is always the interesting
    -- one.
    SELECT COALESCE(array_agg(e.key ORDER BY e.key), '{}')
      INTO v_missing
      FROM jsonb_each(v_blob) e
     WHERE jsonb_typeof(e.value) = 'object'
       AND NOT EXISTS (SELECT 1 FROM camp_canteen_accounts a
                        WHERE a.camp_id = p_camp_id AND a.account_key = e.key
                          AND a.deleted_at IS NULL);

    -- Every balance, to the cent. This is the assertion that the move lost no
    -- money, and it is the one that mattered in 208 when a reduce-then-diff
    -- bug quietly put a family back to an older amount.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account', e.key,
               'inBlob',  COALESCE(NULLIF(e.value ->> 'balance', '')::numeric, 0),
               'inRow',   a.balance)), '[]'::jsonb)
      INTO v_mismatch
      FROM jsonb_each(v_blob) e
      JOIN camp_canteen_accounts a
        ON a.camp_id = p_camp_id AND a.account_key = e.key AND a.deleted_at IS NULL
     WHERE a.balance IS DISTINCT FROM COALESCE(NULLIF(e.value ->> 'balance', '')::numeric, 0);

    -- The accounts a human has to look at: money filed under a name no camper
    -- answers to. Zero-balance ones are listed separately because they need no
    -- decision — nothing is owed either way.
    SELECT jsonb_build_object(
               'count',        count(*),
               'withMoney',    count(*) FILTER (WHERE balance <> 0),
               'owedToCampers', COALESCE(sum(balance) FILTER (WHERE balance > 0), 0),
               'names',        COALESCE(jsonb_agg(account_key ORDER BY account_key)
                                        FILTER (WHERE balance <> 0), '[]'::jsonb))
      INTO v_unattr
      FROM camp_canteen_accounts
     WHERE camp_id = p_camp_id AND deleted_at IS NULL AND person_id IS NULL;

    RETURN jsonb_build_object(
        'accountsInBlob',   v_in_blob,
        'accountsInRows',   v_in_rows,
        'everyAccountHasRow', (v_missing = '{}'),
        'missingAccounts',  to_jsonb(v_missing),
        'balancesMatch',    (v_mismatch = '[]'::jsonb),
        'balanceMismatches', v_mismatch,
        'attributed',       (SELECT count(*) FROM camp_canteen_accounts
                              WHERE camp_id = p_camp_id AND deleted_at IS NULL
                                AND person_id IS NOT NULL),
        'unattributed',     v_unattr,
        'heldInRows',       (SELECT COALESCE(sum(balance), 0) FROM camp_canteen_accounts
                              WHERE camp_id = p_camp_id AND deleted_at IS NULL),
        'heldInBlob',       (SELECT COALESCE(sum(COALESCE(NULLIF(e.value ->> 'balance', '')::numeric, 0)), 0)
                               FROM jsonb_each(v_blob) e WHERE jsonb_typeof(e.value) = 'object')
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_canteen_accounts(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_canteen_accounts(uuid) TO authenticated, service_role;


-- ─── what this file deliberately does NOT do ────────────────────────────────
-- * No reader or writer moves. submit_canteen_purchase and the other 13 still
--   take the camp-wide lock and still speak names. 218 switches the readers,
--   219 moves the writers and the lock goes.
-- * It does not guess an owner for the 354 unattributable accounts. Run
--   verify_canteen_accounts() per camp, fix the roster where a camper is
--   genuinely missing, then re-run backfill_canteen_accounts() — attribution
--   re-runs for rows that are still NULL and never re-points one that is set.
-- * It does not convert canteen_transactions. That ledger already carries a
--   camper_id column; pointing it at person_id belongs with 219, where the
--   writers that populate it move.


-- ─── did it work? ───────────────────────────────────────────────────────────
SELECT 'migration 217 applied'                                             AS status,
       (SELECT count(*) FROM camp_canteen_accounts WHERE deleted_at IS NULL) AS account_rows,
       (SELECT count(*) FROM camp_canteen_accounts
         WHERE deleted_at IS NULL AND person_id IS NOT NULL)               AS attributed,
       (SELECT count(*) FROM camp_canteen_accounts
         WHERE deleted_at IS NULL AND person_id IS NULL)                   AS unattributed,
       (SELECT count(*) FROM camp_canteen_accounts
         WHERE deleted_at IS NULL AND person_id IS NULL AND balance <> 0)  AS unattributed_with_money,
       (SELECT COALESCE(sum(balance), 0) FROM camp_canteen_accounts
         WHERE deleted_at IS NULL)                                         AS total_held;
