-- ============================================================================
-- Migration 160: enforce a STAFF MEMBER's section access in the database.
--
-- Phase 3 of ENTITLEMENTS_DESIGN.md, and the last of the three access layers to
-- become real:
--
--     camp entitlement   (what the camp bought)    -> enforced by 157/158
--     user product_access (which apps)             -> browser only
--     user section_access (which sections)         -> browser only  <-- THIS
--
-- Until now section_access appeared in ZERO RLS policies. A manager or
-- scheduler configured with payroll:none could still read campistryMePayroll
-- out of camp_state_kv with curl and a valid session — pay rates, home
-- addresses, the lot — and write it back. The browser hid the page; nothing
-- stopped the request.
--
-- ── SCOPE: TWO KEYS, DELIBERATELY ──────────────────────────────────────────
-- The plan says "only for keys whose readers are all accounted for, one key at
-- a time". This does campistryMePayroll and campistryMeFinance and nothing
-- else, because those two are the only keys where that is honestly true: they
-- were created by migration 158, their only readers are campistry_me.js and
-- campistry_birthdays.js, and both were written in the same change.
--
-- NOT done here, on purpose:
--   * campistrySnacks — read by the POS (counselor role), the Snacks manager,
--     Campistry Lite and several parent-facing SECURITY DEFINER RPCs. Gating it
--     needs each of those audited first.
--   * campistryHealth, campistryShop, campistryLuggage — same reason, fewer
--     readers. Next, one at a time.
--   * campistryMe / app1 / campStructure — 55 user-session call sites,
--     including a raw REST fetch in a beforeunload handler and an anonymous
--     page that upserts the whole blob. Last, if ever.
--
-- ── WHY WRITES ARE GATED ON "NOT NONE" AND NOT ON "EDIT" ───────────────────
-- me.finance is flagged view-only in the capability registry, so C.resolve
-- never returns 'edit' for it — not for a manager, not for an admin, not for
-- the OWNER. Gating writes on level='edit' would therefore make Finance
-- permanently unsaveable for every user in every camp, and the failure would be
-- a silent RLS denial on save rather than anything the page reports.
--
-- view-only is a UI affordance (it greys out the controls), not a storage rule,
-- and the Finance page legitimately writes budget and expenses. So the storage
-- boundary here is "can this person reach the section at all", and edit-vs-view
-- stays where it already works. Revisit only with a view-only cap that the UI
-- genuinely never writes.
--
-- Idempotent. Requires 159 (the generated registry tables).
-- ============================================================================

-- ─── 1. The resolver ────────────────────────────────────────────────────────
-- A faithful mirror of C.resolve() in campistry_capabilities.js. Every branch
-- below exists because that function has it; the order is its order. If you
-- change one, change both — tests/access_registry_sql.test.js pins the JS side
-- and the truth table at the bottom of 159 is generated from it.
CREATE OR REPLACE FUNCTION public.user_section_level(p_camp_id uuid, p_cap_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_caller      uuid := auth.uid();
    v_app         text;
    v_section     text;
    v_view_only   boolean;
    v_role        text;
    v_products    jsonb;
    v_preset      text;
    v_overrides   jsonb;
    v_group_id    uuid;
    v_grp_found   boolean := false;
    v_grp_products jsonb;
    v_grp_preset   text;
    v_grp_sections jsonb;
    v_level       text;
    v_explicit    boolean;
    v_unconfigured boolean;
BEGIN
    IF v_caller IS NULL THEN RETURN 'none'; END IF;

    SELECT app, section, view_only
      INTO v_app, v_section, v_view_only
      FROM access_capabilities WHERE cap_key = p_cap_key;
    -- Not in the registry at all -> not a section we gate. Allow, matching
    -- S.level()'s "lvl === undefined ? 'edit'" rather than blocking a page we
    -- simply haven't catalogued.
    IF NOT FOUND THEN RETURN 'edit'; END IF;

    -- Camp owner: always full. Same short-circuit as get_my_access, and for the
    -- same reason — anything else and an owner can lock themselves out with no
    -- way back in. The CAMP ENTITLEMENT still caps them, but that is enforced
    -- separately (157) and is about what was bought, not who this is.
    IF EXISTS (SELECT 1 FROM camps WHERE id = p_camp_id AND owner = v_caller) THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    SELECT role, product_access, access_preset, section_access, access_group_id
      INTO v_role, v_products, v_preset, v_overrides, v_group_id
      FROM camp_users
     WHERE camp_id = p_camp_id AND user_id = v_caller
     LIMIT 1;

    -- Not a resolvable member. Fail OPEN, matching get_my_access. This is not a
    -- hole: every policy using this function also requires
    -- camp_id = get_user_camp_id(), so a non-member never reaches here. Failing
    -- closed would only lock out a legitimate user during the window where
    -- membership hasn't propagated.
    IF NOT FOUND THEN RETURN 'edit'; END IF;

    -- A group assignment replaces the member's own columns WHOLESALE (no
    -- merge) — migration 097's intended behaviour, and 154's fix. Branch on
    -- FOUND, never on "record IS NOT NULL": a group whose access_preset is NULL
    -- fails a row-value null test and would silently fall through to the
    -- member's own empty columns, which reads as unconfigured and grants
    -- everything. That exact bug is what 154 existed to fix.
    IF v_group_id IS NOT NULL THEN
        SELECT product_access, access_preset, section_access
          INTO v_grp_products, v_grp_preset, v_grp_sections
          FROM camp_access_groups WHERE id = v_group_id;
        v_grp_found := FOUND;
    END IF;
    IF v_grp_found THEN
        v_products  := v_grp_products;
        v_preset    := v_grp_preset;
        v_overrides := v_grp_sections;
    END IF;

    v_products  := COALESCE(v_products,  '[]'::jsonb);
    v_overrides := COALESCE(v_overrides, '{}'::jsonb);
    -- Normalise exactly as campistry_access_sections.js apply() does before it
    -- hands the access object to resolve(), because that normalisation is what
    -- the JS rules are actually written against:
    --
    --   preset: data.preset || null     -> an EMPTY STRING is no preset.
    --
    -- This matters. Without it, a preset column holding '' is "not NULL" here,
    -- so the user is treated as configured, the lookup finds no grant row, and
    -- the level falls to 'none' — locking someone out of a section the browser
    -- shows them, which is the worst kind of divergence to debug.
    IF v_preset = '' THEN v_preset := NULL; END IF;

    -- Owners and admins are never gated by the per-STAFF layers.
    IF v_role IN ('owner', 'admin') THEN
        RETURN CASE WHEN v_view_only THEN 'view' ELSE 'edit' END;
    END IF;

    -- The product gate comes first: no access to the app, no access to any of
    -- its sections.
    --
    -- An EMPTY products array means "no product restriction recorded", NOT "no
    -- products". resolve() itself would deny everything for [] — it tests
    -- `Array.isArray(products) && indexOf(app) < 0` with no length check — but
    -- it never sees one, because apply() maps an empty array to null first
    -- (`data.products.length ? data.products : null`) on BOTH the group and the
    -- member path. Reading camp_users/camp_access_groups directly, this
    -- function CAN see [], so the length test is what keeps it faithful.
    -- Dropping it would lock out every member whose product_access is [].
    IF jsonb_typeof(v_products) = 'array'
       AND jsonb_array_length(v_products) > 0
       AND NOT (v_products ? v_app) THEN
        RETURN 'none';
    END IF;

    -- THE BACKWARD-COMPATIBILITY RULE: a user with no preset and no overrides
    -- has never had section access configured, and keeps the behaviour from
    -- before section access existed — full use of every app they can open.
    v_unconfigured := (v_preset IS NULL AND v_overrides = '{}'::jsonb);

    IF v_unconfigured THEN
        v_level := 'edit';
    ELSE
        -- 'finance' was split out of what used to be one 'analytics' capability
        -- ("Analytics & Finance"). Access configured before that split only
        -- names 'analytics', so treating 'finance' as just another unlisted key
        -- would silently hide financial data from people who already had it.
        -- Until it is named explicitly — a real override, or a preset that
        -- names it — 'finance' simply IS 'analytics'. Recursing (rather than
        -- reading the analytics row directly) also picks up that key's own
        -- wildcard and legacy fallbacks.
        IF v_section = 'finance' AND NOT (v_overrides ? p_cap_key) THEN
            SELECT explicit INTO v_explicit
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
            IF v_preset IS NULL OR NOT COALESCE(v_explicit, false) THEN
                RETURN public.user_section_level(p_camp_id, v_app || '.analytics');
            END IF;
        END IF;

        IF v_overrides ? p_cap_key THEN
            v_level := v_overrides ->> p_cap_key;
        ELSIF v_preset IS NOT NULL THEN
            SELECT level INTO v_level
              FROM access_preset_grants
             WHERE preset = v_preset AND cap_key = p_cap_key;
        ELSE
            -- Overrides exist but this key isn't among them and there is no
            -- preset: the owner is picking sections explicitly, so anything
            -- unlisted is off.
            v_level := 'none';
        END IF;
    END IF;

    IF v_level IS NULL OR v_level NOT IN ('none', 'view', 'edit') THEN
        v_level := 'none';
    END IF;

    -- A read-only role can never come out above 'view', whatever the preset
    -- says — the fail-closed floor from access_control.
    IF v_role IN ('viewer', 'counselor') AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;
    IF v_view_only AND v_level = 'edit' THEN
        v_level := 'view';
    END IF;

    RETURN v_level;
END;
$$;
REVOKE ALL ON FUNCTION public.user_section_level(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.user_section_level(uuid, text) TO authenticated, service_role;

-- ─── 2. Which keys this applies to ──────────────────────────────────────────
-- One place, so read and write can never disagree. Anything not named returns
-- true: this migration cannot affect a key it does not list, which is what
-- makes adding the next key a one-line change with a bounded blast radius.
CREATE OR REPLACE FUNCTION public.camp_state_key_user_allowed(p_camp_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN CASE p_key
        WHEN 'campistryMePayroll' THEN public.user_section_level(p_camp_id, 'me.payroll') <> 'none'
        WHEN 'campistryMeFinance' THEN public.user_section_level(p_camp_id, 'me.finance') <> 'none'
        ELSE true
    END;
END;
$$;
REVOKE ALL ON FUNCTION public.camp_state_key_user_allowed(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.camp_state_key_user_allowed(uuid, text) TO authenticated, service_role;

-- ─── 3. The policies ────────────────────────────────────────────────────────
-- 158's predicates with the per-user check conjoined. All FOUR policies that
-- can touch these keys are rewritten: Postgres OR-combines permissive policies,
-- so leaving one without the check would reopen the door through it. (099's two
-- counselor-snacks policies are scoped to key='campistrySnacks' and so cannot
-- reach these keys; they keep 157's entitlement gate and are left alone.)

DROP POLICY IF EXISTS camp_state_kv_select ON camp_state_kv;
CREATE POLICY camp_state_kv_select ON camp_state_kv
    FOR SELECT
    USING (
        camp_id = get_user_camp_id()
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
        AND (
            get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
            OR (
                get_user_role() = 'counselor'::text
                AND key <> ALL (ARRAY['app1'::text, 'campistryMe'::text, 'campistryHealth'::text,
                                      'campistryMePayroll'::text, 'campistryMeFinance'::text])
            )
        )
    );

DROP POLICY IF EXISTS camp_state_kv_insert ON camp_state_kv;
CREATE POLICY camp_state_kv_insert ON camp_state_kv
    FOR INSERT
    WITH CHECK (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_update ON camp_state_kv;
CREATE POLICY camp_state_kv_update ON camp_state_kv
    FOR UPDATE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text, 'scheduler'::text])
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

DROP POLICY IF EXISTS camp_state_kv_delete ON camp_state_kv;
CREATE POLICY camp_state_kv_delete ON camp_state_kv
    FOR DELETE
    USING (
        camp_id = get_user_camp_id()
        AND get_user_role() = 'owner'::text
        AND camp_state_key_entitled(camp_id, key)
        AND camp_state_key_user_allowed(camp_id, key)
    );

-- ─── Sanity checks ─────────────────────────────────────────────────────────
-- As the OWNER, nothing changes — these must still read as they did:
--   select user_section_level('<camp>'::uuid, 'me.payroll');   -- edit
--   select user_section_level('<camp>'::uuid, 'me.finance');   -- view (view-only cap)
--
-- As an UNCONFIGURED staff member (no preset, no overrides) nothing changes
-- either — that is the backward-compatibility rule:
--   -- expect edit / view, NOT none
--
-- As a staff member on the 'nurse' preset:
--   select user_section_level('<camp>'::uuid, 'me.payroll');   -- none
--   select key from camp_state_kv where key = 'campistryMePayroll';  -- 0 rows
--
-- Every value the resolver should produce is listed in the generated truth
-- table at the bottom of migration 159. Compare against it:
--   select preset, level from access_preset_grants
--    where cap_key = 'me.payroll' order by preset;
--
-- All four policies must carry the per-user check — one that doesn't is a hole,
-- because Postgres ORs permissive policies together:
--   select policyname, cmd,
--          (coalesce(qual,'') || coalesce(with_check,'')
--             like '%camp_state_key_user_allowed%') as gated
--     from pg_policies where tablename = 'camp_state_kv' order by policyname;
--   -- expect the 4 unsuffixed policies true; the 2 *_counselor_snacks false
-- ============================================================================
