-- ============================================================================
-- Migration 244: a new child does not inherit a renamed child's canteen account.
--
-- THE DEFECT. Every canteen writer — the register, the desk, parent deposits,
-- card credits, auto-reload — finds the account through 227's
--
--     canteen_account_key_for(camp, name):
--         person := camp_person_by_name(camp, name)
--         the account whose person_id = person, else the name itself
--
-- "else the name itself" is the hole. Account keys never change (they are the
-- primary key, and every ledger row holds one), so a renamed camper's account
-- is still keyed by their OLD spelling. Now:
--
--   1. Chaya Levy is renamed to Chaya Levi. Her account is still keyed
--      "Chaya Levy", attributed to her id. Correct.
--   2. A different child, also Chaya Levy, is added. She has no account yet.
--   3. Her first purchase: key_for("Chaya Levy") → person = the NEW child →
--      no account for her → falls back to the key "Chaya Levy" → which is the
--      FIRST child's account.
--
-- The new child spends the first child's money; a parent's deposit for the new
-- child lands on the first child. Reproduced against the full chain while
-- writing 243's test, where a rename plus a reused name put a $50 deposit on
-- the wrong child.
--
-- THE FIX. When a person has no account and the bare spelling is held by a
-- DIFFERENT person's account, the new account's key is "<name> #<person_id>" —
-- the same shape campistry_snacks.js already uses for the other half of this
-- problem (a new camper sharing a name with a CLOSED account moves the old one
-- to "<name> #<id>"). The attribution function learns the suffix, so the
-- account is born attributed to the right child.
--
-- Nothing changes for any account that already exists, for a name that resolves
-- to nobody, or for a person who already has an account.
--
-- HOW TO APPLY. Paste into the SQL Editor. One transaction, idempotent, moves no
-- data. Two CREATE OR REPLACEs and a check.
--
-- Standalone. NOT part of APPLY_BUNDLE.sql.
-- ============================================================================

DO $$
BEGIN
    IF to_regprocedure('public.canteen_account_key_for(uuid,text)') IS NULL THEN
        RAISE EXCEPTION '244 rewrites canteen_account_key_for — apply 227 first';
    END IF;
END $$;

SET LOCAL lock_timeout = '15s';


-- ─── 1. the key a name's money lives on ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.canteen_account_key_for(p_camp_id uuid, p_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_person bigint;
    v_key    text;
    v_holder bigint;
BEGIN
    IF p_camp_id IS NULL OR COALESCE(btrim(p_key), '') = '' THEN
        RETURN p_key;
    END IF;

    v_person := public.camp_person_by_name(p_camp_id, p_key);
    IF v_person IS NULL THEN
        RETURN p_key;
    END IF;

    SELECT a.account_key INTO v_key
      FROM camp_canteen_accounts a
     WHERE a.camp_id = p_camp_id AND a.person_id = v_person;
    IF v_key IS NOT NULL THEN
        RETURN v_key;
    END IF;

    -- This person has no account yet. The bare spelling is theirs to take —
    -- unless an account under it already belongs to SOMEBODY ELSE, which is a
    -- renamed or departed child's money. Then this child gets their own key.
    SELECT a.person_id INTO v_holder
      FROM camp_canteen_accounts a
     WHERE a.camp_id = p_camp_id AND a.account_key = p_key;
    IF v_holder IS NOT NULL AND v_holder <> v_person THEN
        RETURN p_key || ' #' || v_person;
    END IF;

    RETURN p_key;
END;
$$;
REVOKE ALL ON FUNCTION public.canteen_account_key_for(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canteen_account_key_for(uuid, text) TO authenticated, service_role;


-- ─── 2. who a new account belongs to ────────────────────────────────────────
-- The name first, as before. Then the "#<id>" suffix the key function above —
-- and the Snacks page's own archive — writes: an account keyed "Chaya Levy #412"
-- belongs to camper 412, whatever the name in front of it resolves to now.
CREATE OR REPLACE FUNCTION public._attribute_canteen_account(p_camp_id uuid, p_key text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT COALESCE(
        public.camp_person_by_name(p_camp_id, p_key),
        (SELECT p.person_id
           FROM camp_people p
          WHERE p.camp_id = p_camp_id
            AND p.kind = 'camper'
            AND p_key ~ ' #[0-9]+$'
            AND p.person_id = substring(p_key FROM ' #([0-9]+)$')::bigint
          LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public._attribute_canteen_account(uuid, text) FROM public, anon, authenticated;


-- ─── 3. the check ───────────────────────────────────────────────────────────
-- Accounts attributed to one person but keyed by a spelling that now belongs to
-- a DIFFERENT live person. Those are exactly the accounts the old rule would
-- have handed to the wrong child; after this migration they are safe, and the
-- count says how many camps would have been exposed.
CREATE OR REPLACE FUNCTION public.verify_renamed_accounts_are_safe(p_camp_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'key_for_mints_a_key', regexp_replace(
            (SELECT prosrc FROM pg_proc
              WHERE oid = to_regprocedure('public.canteen_account_key_for(uuid,text)')),
            '--[^\n]*', '', 'g') ~ '''\s*#''',
        'accounts_whose_old_name_is_now_someone_else', (
            SELECT count(*)
              FROM camp_canteen_accounts a
             WHERE (p_camp_id IS NULL OR a.camp_id = p_camp_id)
               AND a.person_id IS NOT NULL
               AND a.deleted_at IS NULL
               AND public.camp_person_by_name(a.camp_id, a.account_key) IS DISTINCT FROM a.person_id
               AND public.camp_person_by_name(a.camp_id, a.account_key) IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION public.verify_renamed_accounts_are_safe(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_renamed_accounts_are_safe(uuid) TO authenticated, service_role;

SELECT public.verify_renamed_accounts_are_safe()
       AS "244 check — key_for_mints_a_key should be true";
