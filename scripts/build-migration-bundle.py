#!/usr/bin/env python3
"""
Rebuild migrations/APPLY_BUNDLE.sql from the ordered manifest below.

WHY THIS EXISTS: this repo has no migration runner — every migration is pasted
into the Supabase SQL Editor by hand — and migration numbers 146-151 were each
used twice (once by the payments work, once by the bank-deposit/template work),
so "have I already run 150?" has no reliable answer. The bundle is the answer:
one paste, safe to re-run, that puts the whole set in place.

It is GENERATED so it can't drift. Add a migration to MANIFEST, re-run:

    python3 scripts/build-migration-bundle.py

ORDER IS LOAD-BEARING. Several of these redefine the same object, and the last
one wins:
  * 146, 148, 149 each rewrite the Banquest credential_fields  -> 149 wins
  * 146, 150 each redefine get_camp_public_tokenization_key    -> 150 wins
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIG = os.path.join(REPO, "migrations")
OUT = os.path.join(MIG, "APPLY_BUNDLE.sql")

# (filename without .sql, one-line description) — in APPLY order.
MANIFEST = [
    ("146_banquest_real_api_credentials",
     "Banquest credential shape (sourceKey/pin/tokenizationKey/gatewayUrl/tokenizationUrl)"),
    ("147_clear_stale_byop_cards_on_switch",
     "Scrub saved cards belonging to a processor the camp no longer uses"),
    ("148_banquest_api_host_labels",
     "Correct the Banquest API host guidance (api.* host, /api/v2)"),
    ("149_banquest_hosted_payment_pages",
     "Hosted Payment Page support: banquest_pending_links + credential fields"),
    ("150_card_form_field_config",
     "Admin-configurable card-form fields, returned by the public tokenization RPC"),
    ("151_backfill_saved_payment_methods",
     "Backfill savedPaymentMethods[] from legacy single-slot card fields"),
    ("152_fix_get_my_balance_attribution",
     "Credit payments by familyKey/family name; stop summing unreported families"),
    ("153_stripe_is_not_the_default",
     "Stripe becomes a selectable processor; 'none' is the new default"),
    ("154_fix_get_my_access_group_resolution",
     "Section access actually applies: fix the unassigned-record and NULL-preset bugs"),
    ("155_camp_entitlements",
     "Camp entitlements: what the camp bought, capping owners too (phase 1, no DB enforcement yet)"),
    ("156_entitlements_control_rpcs",
     "Super-admin RPCs behind campistry_control.html (list camps, set entitlements)"),
    ("157_entitlement_enforcement_per_key",
     "Entitlements enforced in the DATABASE, per camp_state_kv key (phase 2A)"),
    # MUST come after 157: it redefines camp_state_key_entitled and rewrites the
    # SELECT policy 157 creates. Running them the other way round would drop the
    # two new keys back out of the gate and out of the counselor exclusion.
    ("158_split_payroll_finance_keys",
     "Payroll and Finance get their own keys so the entitlement can reach them (phase 2B)"),
    # 159 is GENERATED from campistry_capabilities.js by
    # scripts/build-access-registry-sql.js — never edit it here or by hand.
    ("159_access_registry_tables",
     "The capability registry and preset expansions, in SQL (generated)"),
    # MUST come after 158 and 159: it needs the registry tables, and it rewrites
    # the four camp_state_kv policies 158 leaves in place.
    ("160_per_user_key_rls",
     "A staff member's section access enforced in RLS, for the two Me keys (phase 3)"),
    # MUST come after 160: it redefines camp_state_key_user_allowed to add the
    # snacks key, and re-creates 099's counselor POS policies with the check.
    ("161_per_user_snacks_key_rls",
     "Per-user section access on campistrySnacks, counselor POS included (phase 3)"),
]

HEADER = """-- ═══════════════════════════════════════════════════════════════════════════
-- CAMPISTRY — payments, billing and access bundle
--
-- GENERATED FILE — do not edit by hand.
-- Rebuild with:  python3 scripts/build-migration-bundle.py
--
-- Run this whole file in the Supabase SQL Editor. SAFE TO RE-RUN as often as
-- you like: every statement is CREATE OR REPLACE, IF NOT EXISTS, ON CONFLICT DO
-- NOTHING, or an UPDATE whose WHERE clause matches nothing once applied.
-- Running it a second time changes nothing.
--
-- WHY A BUNDLE: there is no migration runner here — migrations are pasted in by
-- hand — and numbers 146-151 were each used TWICE in this repo (once by the
-- payments work, once by the bank-deposit/template work), so "have I run 150?"
-- is ambiguous. This contains only the payments/access set, in dependency
-- order, so you can run it and know the whole set is in place.
--
-- WHAT YOU WILL NOTICE AFTERWARDS:
--   * Parents stop being told they owe money they already paid (152).
--   * Cards saved on Campistry's card page appear under Link -> Cards (151).
--   * Stripe is no longer the default processor; a camp that has not connected
--     one reads 'none' and online payments stay off until it does (153).
--   * !! Section access starts actually applying (154). Until now it silently
--     granted full access to every ungrouped staff member, so anyone you had
--     configured with restrictions has been seeing everything. They will now be
--     gated as intended — tell your staff before running this, so a suddenly
--     restricted person isn't reported to you as a regression.
--   * Camp entitlements start being enforced by the database, not just hidden
--     in the browser (155-157). This changes NOTHING for any existing camp:
--     every camp is unrestricted until an entitlement is deliberately set from
--     the control page, and setting one back to unrestricted undoes it.
--   * Payroll and Finance move into their own rows so that gate can reach them
--     (158). DEPLOY THE SITE BEFORE RUNNING THIS — the new page reads the new
--     rows and falls back to the old blob, so it is correct either way round,
--     but old code running against moved data would show empty pages. The
--     family payment ledger deliberately does NOT move.
--   * !! A staff member's SECTION access starts being enforced by the database
--     for Payroll and Finance (159/160), not just hidden in the browser. Until
--     now a manager with payroll:none could still read the data out of the API
--     with a valid session. Anyone who was never configured (no preset, no
--     overrides) is unaffected — that is the backward-compatibility rule — but
--     anyone you DID restrict can no longer reach those two keys at all.
--     161 extends the same rule to the canteen (campistrySnacks): staff with no
--     snacks access — nurse, division head, office, bus coordinator presets —
--     stop being able to read camper balances and the transaction ledger. The
--     POS register is unaffected: it runs as a counselor, and an unconfigured
--     counselor still passes the gate.
--
-- PREREQUISITES (long since applied on a live camp; the preflight below fails
-- loudly rather than confusingly if one is missing): 077 (camp Stripe Connect),
-- 126 (BYOP framework), 129/130 (disconnect RPCs), 137/139 (saved cards),
-- 097 (access groups).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Preflight: fail with a readable message instead of a confusing error
-- ─── several hundred lines down.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='camp_state_kv') THEN
        RAISE EXCEPTION 'No camp_state_kv table — this is not a Campistry database.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='camps' AND column_name='payment_processor_key') THEN
        RAISE EXCEPTION 'Missing camps.payment_processor_key — apply migration 126 (BYOP framework) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='camps' AND column_name='stripe_account_id') THEN
        RAISE EXCEPTION 'Missing camps.stripe_account_id — apply migration 077 (camp Stripe Connect) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='payment_processor_catalog') THEN
        RAISE EXCEPTION 'Missing payment_processor_catalog — apply migration 126 first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_name='camp_access_groups') THEN
        RAISE EXCEPTION 'Missing camp_access_groups — apply migration 097 (access groups) first.';
    END IF;
    RAISE NOTICE 'Preflight OK — applying bundle.';
END
$preflight$;
"""

FOOTER = """

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY: backfill saved cards for every camp.
--
-- Additive and idempotent — it only creates a savedPaymentMethods[] entry for a
-- family that already has a legacy card token and no array entry carrying that
-- same token, so a second run adds nothing. Without it, a card saved before the
-- fix stays chargeable but invisible under Link -> Cards.
--
-- _admin_clear_stale_byop_cards is deliberately NOT run here: it DELETES cards
-- belonging to a processor the camp no longer uses, which is right after
-- switching processors but is not something an "apply everything" script should
-- ever do unprompted.
-- ═══════════════════════════════════════════════════════════════════════════
DO $backfill$
DECLARE
    c        record;
    v_result jsonb;
    v_total  int := 0;
BEGIN
    FOR c IN SELECT id FROM camps LOOP
        v_result := public._admin_backfill_saved_payment_methods(c.id);
        v_total  := v_total + COALESCE((v_result->>'added')::int, 0);
    END LOOP;
    RAISE NOTICE 'Saved-card backfill complete — % card(s) added across all camps.', v_total;
END
$backfill$;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — every row should read OK. Anything else means that piece did
-- not apply; re-run the bundle and read the error.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 'banquest credential fields (paymentPageSlug present)' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM payment_processor_catalog
                          WHERE key='banquest' AND credential_fields::text LIKE '%paymentPageSlug%')
            THEN 'OK' ELSE 'MISSING' END AS result
UNION ALL SELECT '''none'' processor exists',
       CASE WHEN EXISTS (SELECT 1 FROM payment_processor_catalog WHERE key='none')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'camps default is ''none''',
       CASE WHEN (SELECT column_default FROM information_schema.columns
                   WHERE table_name='camps' AND column_name='payment_processor_key') LIKE '%none%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'no camp left on the old stripe default',
       CASE WHEN NOT EXISTS (SELECT 1 FROM camps
                              WHERE payment_processor_key='stripe' AND stripe_account_id IS NULL)
            THEN 'OK' ELSE 'STILL PRESENT' END
UNION ALL SELECT 'banquest_pending_links table',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='banquest_pending_links')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'tokenization RPC returns cardFormFields',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_camp_public_tokenization_key' LIMIT 1) LIKE '%cardFormFields%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_balance credits payments by familyKey',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance' LIMIT 1) LIKE '%familyKey%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_access uses scalars, not an unassigned record',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_access' LIMIT 1) LIKE '%v_grp_found%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'saved-card backfill function',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_backfill_saved_payment_methods')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'stale-card cleanup function',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_clear_stale_byop_cards')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'stripe-selected helper',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='_admin_set_camp_stripe_selected')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'camps.entitlements column',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='camps' AND column_name='entitlements')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_access returns entitlements',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_access' LIMIT 1) LIKE '%entitlements%'
            THEN 'OK' ELSE 'MISSING' END
-- Every permissive policy must carry the gate: Postgres ORs them together, so
-- one policy without it is a hole through the whole entitlement.
UNION ALL SELECT 'all 6 camp_state_kv policies entitlement-gated',
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE tablename='camp_state_kv'
                     AND COALESCE(qual,'') || COALESCE(with_check,'')
                         LIKE '%camp_state_key_entitled%') = 6
            THEN 'OK' ELSE 'MISSING' END
-- The payroll/finance split is only safe if counselors are excluded from the
-- two NEW keys. Being buried inside campistryMe used to keep them out; lifting
-- them into their own keys would otherwise hand every counselor the payroll
-- file, because the SELECT policy allows a counselor any key it does not name.
UNION ALL SELECT 'counselors excluded from the new payroll/finance keys',
       CASE WHEN (SELECT COALESCE(qual,'') FROM pg_policies
                   WHERE tablename='camp_state_kv' AND policyname='camp_state_kv_select')
                 LIKE '%campistryMePayroll%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'payroll/finance reachable by the entitlement',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='camp_state_key_entitled' LIMIT 1)
                 LIKE '%campistryMeFinance%'
            THEN 'OK' ELSE 'MISSING' END
-- The ledger must NOT have moved: seven payment edge functions and
-- get_my_balance read campistryMe.finance.payments and were not redeployed.
UNION ALL SELECT 'payment ledger still in campistryMe',
       CASE WHEN NOT EXISTS (SELECT 1 FROM camp_state_kv
                              WHERE key='campistryMeFinance' AND value ? 'payments')
            THEN 'OK' ELSE 'LEDGER MOVED — INVESTIGATE' END
-- Phase 3. The registry tables are generated from campistry_capabilities.js;
-- if the counts are wrong the database is resolving against stale rules.
UNION ALL SELECT 'access registry loaded (' || (SELECT count(*)::text FROM access_capabilities)
                 || ' capabilities)',
       CASE WHEN (SELECT count(*) FROM access_capabilities) > 0
             AND (SELECT count(*) FROM access_preset_grants) =
                 (SELECT count(*) FROM access_capabilities)
                 * (SELECT count(DISTINCT preset) FROM access_preset_grants)
            THEN 'OK' ELSE 'MISSING' END
-- All SIX policies, the two counselor POS ones included: gating only the four
-- main policies leaves a counselor writing the canteen straight past the check,
-- because Postgres OR-combines permissive policies.
UNION ALL SELECT 'per-user section access on all 6 camp_state_kv policies',
       CASE WHEN (SELECT count(*) FROM pg_policies
                   WHERE tablename='camp_state_kv'
                     AND COALESCE(qual,'') || COALESCE(with_check,'')
                         LIKE '%camp_state_key_user_allowed%') = 6
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'snacks key gated per user',
       CASE WHEN (SELECT prosrc FROM pg_proc
                   WHERE proname='camp_state_key_user_allowed' LIMIT 1) LIKE '%campistrySnacks%'
            THEN 'OK' ELSE 'MISSING' END
-- me.finance is a view-only capability and never resolves to 'edit' for
-- anyone, the owner included. If the key gate ever tests for 'edit', Finance
-- becomes permanently unsaveable for every user in every camp.
UNION ALL SELECT 'finance writes gated on "not none", not "edit"',
       CASE WHEN (SELECT prosrc FROM pg_proc
                   WHERE proname='camp_state_key_user_allowed' LIMIT 1) LIKE '%<> ''none''%'
            THEN 'OK' ELSE 'MISSING' END;
"""


def main():
    parts = [HEADER]
    missing = []
    for name, desc in MANIFEST:
        path = os.path.join(MIG, name + ".sql")
        if not os.path.exists(path):
            missing.append(name)
            continue
        with open(path, encoding="utf-8") as fh:
            body = fh.read().rstrip()
        parts.append(
            "\n\n-- #########################################################################\n"
            "-- ###### {}\n"
            "-- ###### {}\n"
            "-- #########################################################################\n\n".format(name, desc)
            + body + "\n"
        )
    if missing:
        sys.exit("Missing migration file(s): " + ", ".join(missing))
    parts.append(FOOTER)

    out = "".join(parts)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(out)
    print("Wrote {} ({} bytes, {} migrations)".format(
        os.path.relpath(OUT, REPO), len(out), len(MANIFEST)))

    # Validate against the real PostgreSQL grammar when pglast is available.
    try:
        import pglast
        stmts = pglast.parse_sql(out)
        print("Parsed OK — {} top-level statements.".format(len(stmts)))
    except ImportError:
        print("pglast not installed — skipped syntax validation (pip install pglast).")
    except Exception as exc:
        sys.exit("SYNTAX ERROR in generated bundle: {}".format(exc))


if __name__ == "__main__":
    main()
