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
    # ── 122-124 are OLDER than the rest of this bundle and are here because they
    # were in NO bundle at all. That is not a filing detail: a camp owner
    # unenrolled a camper and the parent could still message the camp, which is
    # precisely the symptom of 122 never having been applied. There is no bundle
    # covering 001-145 (APPLY_ALL.sql only carries 024/026/027), so anything in
    # that range was applied by hand, one at a time, and 122 evidently was not.
    #
    # They are one set: 122 adds the camp_connected flag and the server-side
    # gates, 123 fixes a multi-camp union bug 122 introduced, 124 stops a
    # disconnected family's departed camper rendering as a normal child card.
    # Applying 122 without 123 breaks a parent with kids at two camps.
    #
    # All three are idempotent (the column add is IF NOT EXISTS) and they touch
    # nothing the 146+ set touches, so they run first, in ascending order.
    ("122_camper_offboard_link_features",
     "A departed camper disconnects their parent from LIVE features, not from billing"),
    ("123_fix_link_features_union",
     "Multi-camp fix for 122: one camp ending must not disconnect the others"),
    ("124_hide_disconnected_children",
     "Stop showing a disconnected family's departed camper as a current child"),
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
    # Independent of the entitlement work — a read-only reporting RPC. Added
    # here because the bundle is the only way a migration actually gets run on
    # this project; an unregistered file is one nobody ever applies.
    ("162_reconcile_processor_charges",
     "Report card charges the ledger lost to a stale-tab overwrite (read-only)"),
    # MUST come after 161: it redefines camp_state_key_user_allowed and has to
    # carry that migration's snacks entry forward, or replacing the function
    # would silently un-gate the canteen.
    ("163_per_user_health_shop_luggage_rls",
     "Per-user section access on Health, Shop and Luggage (phase 3)"),
    # MUST come after 163 — redefines camp_state_key_user_allowed and has to
    # carry every key the earlier steps gated, or replacing the function
    # silently un-gates them.
    ("164_per_user_campistryme_rls",
     "Per-user gate on campistryMe (whole key only; see the file header)"),
    # MUST come after 159: user_section_level reads access_preset_grants.
    ("165_camp_role_access",
     "Per-JOB access defaults a camp owner can set, plus resolver support"),
    # MUST come after 152 (it redefines get_my_balance) and after 145, whose
    # bank_deposits table it now reads. Independent of the access chain.
    ("166_balance_parity",
     "The parent's balance agrees with the camp's: Zelle counted, all families summed"),
    # Independent of the access chain. Needs the shop order shape from 122.
    ("167_settle_shop_orders",
     "The Camp Shop actually takes the money: canteen debit / camp-bill charge, idempotent"),
    # Independent. Adds the atomic write path the payment edge functions use;
    # additive, so a function still on the old path keeps working.
    ("168_atomic_payment_writes",
     "Atomic, locking, idempotent payment + family writes (stops lost updates)"),
    # Independent. The one payment write that has to move TWO things together —
    # the instalment status and the payment — so it needs its own function
    # rather than 168's append.
    ("169_atomic_autopay_installment",
     "One instalment charge = one locked write (autopay stops losing/repeating charges)"),
    # Independent. Finishes the set: the two card-on-file writes, which move no
    # money on the day but silently break autopay and can erase a canteen sale.
    ("170_atomic_card_on_file_writes",
     "Atomic saved-card writes for families and canteen auto-reload"),
    # Independent. The family balance stops being re-derived from live
    # enrollments and becomes a posted, append-only ledger, so removing a camper
    # can no longer erase a debt. Transitional: reads the ledger when a family
    # has one, falls back to the old derived path when it does not.
    ("171_posted_ledger",
     "The family balance becomes a posted ledger (a debt survives a withdrawal)"),
    # MUST come after 171: record_autopay_charge and plan_due both call
    # family_ledger_balance, and plan_due_for reads a converted plan's shape.
    ("172_autopay_posts_to_ledger",
     "Autopay charges a DERIVED amount and posts it to the ledger (kills D1)"),
    # MUST come after 166 AND 171: it renames 166's get_my_balance aside and
    # wraps it, and the wrapper calls 171's family_has_ledger. The rename is
    # guarded so re-running cannot make the wrapper call itself.
    ("173_parent_balance_from_ledger",
     "The PARENT's balance comes from the posted ledger too (closes 171's gap)"),
    # MUST come after 173: it replaces 173's wrapper in place (same marker, so
    # 173's rename guard keeps working) and adds the completeness test. Without
    # it a ledger that is merely BEHIND reads as authoritative and under-reports
    # to the parent — the $2,500 registration that showed as $0.
    ("174_ledger_must_be_complete",
     "The parent's balance only trusts a ledger that has every billable enrollment"),
    # MUST come after 171 (family_ledger_balance) and 056 (the notifications
    # table and its UNIQUE(camp_id, source, source_id), which is what makes both
    # alerts fire once rather than nightly).
    ("175_chargebacks_and_collection_blocks",
     "A chargeback moves the money back; a plan that cannot collect says so"),
    # MUST come after 126/127/153 (the catalog and every row in it) and after
    # 175, because it declares `chargeback` true on the strength of
    # record_chargeback existing. Its trigger refuses to connect a camp to a
    # processor that does not declare all five, so running it before the rows
    # it corrects would leave Banquest unconnectable.
    ("176_processor_conformance",
     "A processor cannot be connected until it can charge, refund, tokenize, "
     "re-charge and report a dispute"),
    # MUST come after 175, which it replaces record_chargeback from. Cardknox's
    # postback carries no amount field at all, so requiring one meant a dispute
    # we could identify perfectly still went unrecorded.
    ("177_chargeback_amount_from_payment",
     "A chargeback can be recorded even when the processor does not say how much"),
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
--     counselor still passes the gate. 163 finishes the app-level keys
--     (Health, Shop, Luggage) and 164 adds campistryMe as a whole-key gate.
--     Watch for head-counselor and division-head presets losing Health: they
--     grant no health section, but a MANAGER on either can read it today.
--   * !! Parents' balances change (166), and for the better: a Zelle or ACH
--     deposit now counts on the parent's side too. Until now deposits were
--     unioned into the CAMP's ledger and into autopay, but not into
--     get_my_balance — so a family that paid by bank transfer read as settled
--     in Billing and still owing in the parent portal, permanently. Parents
--     with two family records also now see the sum of both rather than one.
--     Expect some parent balances to DROP when you run this; that is the bug
--     being fixed, not a new discount.
--   * Payments stop being lost to a lost update (168-170). The payment webhooks
--     used to read the whole campistryMe blob, append, and write it back with
--     no lock -- so two that overlapped silently discarded one another's
--     payment, and a retried webhook could credit a family twice. The SQL here
--     only adds the atomic path; each edge function starts using it when you
--     redeploy it (see the list in the commit). Functions not yet redeployed
--     keep working exactly as before.
--     169 is for autopay specifically, which had the widest window of the lot:
--     it read every camp's blob at the start of the nightly run and wrote it
--     back at the end, so anything the office saved while it ran was discarded
--     -- and if the office won, the run's OWN charges vanished, cards charged
--     with no record. It now writes each instalment and its payment together,
--     under a lock, and only ever touches an instalment still marked pending,
--     so a failed run is safe to re-run without charging anyone twice.
--     170 covers the two SAVED-CARD writes. Those move no money on the day,
--     which is why they were last and why they matter: losing one silently
--     stops autopay for that family and nobody notices for a month. It also
--     stops the same card being saved twice when a processor redelivers its
--     webhook, and takes the canteen blob off the whole-blob write path -- that
--     blob holds the snack-bar transaction ledger the balances are recomputed
--     from, so a card save landing at the same moment as a purchase could erase
--     the purchase.
--   * !! The Camp Shop starts taking money it never took (167). "Charge to
--     canteen account" and "Charge to camp bill" were labels on a dropdown
--     that settled nothing: the order stored the method and the money was
--     recorded nowhere. Orders placed BEFORE this are not back-charged -- only
--     orders saved from now on settle -- so if you have unpaid shop orders on
--     the books, re-save them to post the charge.
--   * NEW: you can set access once for a whole JOB (165). Before, access was
--     per-person only, so a camp that restricted its four schedulers got a
--     fifth one with the run of the place — an unconfigured user keeps full
--     access. Set it under Team & Access -> "What each job can open", then make
--     exceptions for individuals. A person's own setting always wins.
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
-- All six audited keys must be present in the CURRENT definition. The function
-- is replaced by each step, so a step that forgot to carry an earlier key
-- forward would silently un-gate it.
-- me.finance is a view-only capability and never resolves to 'edit' for
-- anyone, the owner included. If the key gate ever tests for 'edit', Finance
-- becomes permanently unsaveable for every user in every camp.
UNION ALL SELECT 'finance writes gated on "not none", not "edit"',
       CASE WHEN (SELECT prosrc FROM pg_proc
                   WHERE proname='camp_state_key_user_allowed' LIMIT 1) LIKE '%<> ''none''%'
            THEN 'OK' ELSE 'MISSING' END
-- Phase 3 finished: seven keys gated per user.
UNION ALL SELECT 'all 7 audited keys gated per user',
       CASE WHEN (SELECT count(*) FROM (VALUES
                     ('campistryMePayroll'), ('campistryMeFinance'), ('campistrySnacks'),
                     ('campistryHealth'), ('campistryShop'), ('campistryLuggage'),
                     ('campistryMe')
                  ) AS k(name)
                  WHERE (SELECT prosrc FROM pg_proc
                          WHERE proname='camp_state_key_user_allowed' LIMIT 1)
                        LIKE '%' || k.name || '%') = 7
            THEN 'OK' ELSE 'MISSING' END
-- Per-JOB defaults (165).
UNION ALL SELECT 'per-job access defaults available',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables
                          WHERE table_name='camp_role_access')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='set_camp_role_access')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'get_my_access carries the job default',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_access' LIMIT 1) LIKE '%roleAccess%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'the RLS resolver honours job defaults',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='user_section_level' LIMIT 1)
                 LIKE '%camp_role_access%'
            THEN 'OK' ELSE 'MISSING' END
-- Money parity (166). A parent's balance must include Zelle/ACH deposits, or
-- a family that paid by bank transfer is settled for the camp and still owing
-- for the parent, permanently.
UNION ALL SELECT 'parent balance counts Zelle/ACH deposits',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance' LIMIT 1)
                 LIKE '%bank_deposits%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'parent balance sums every family the parent belongs to',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance' LIMIT 1)
                 LIKE '%v_famKeys%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'atomic payment write path',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='append_camp_payment')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='merge_camp_family_fields')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'autopay writes the instalment and the payment together',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='record_autopay_installment')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'saved-card writes are atomic',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='append_family_payment_method')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='merge_canteen_autoreload_card')
            THEN 'OK' ELSE 'MISSING' END
-- Every money RPC must hold a row lock. A new one added without FOR UPDATE is
-- the exact defect 167-170 fixed, and it would look fine until money went
-- missing, so check it here rather than trusting the next author to remember.
UNION ALL SELECT 'every money RPC takes a row lock',
       CASE WHEN NOT EXISTS (
                SELECT 1 FROM pg_proc
                 WHERE proname IN ('append_camp_payment','merge_camp_family_fields',
                                   'record_autopay_installment','settle_shop_order',
                                   'append_family_payment_method','merge_canteen_autoreload_card')
                   AND prosrc NOT LIKE '%FOR UPDATE%')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'the family balance is a posted ledger',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='family_ledger_balance')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='convert_family_ledgers')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='report_plan_undercollection')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'autopay derives the amount and posts to the ledger',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='record_autopay_charge')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='plan_due')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='plan_due_for')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'the parent balance reads the posted ledger',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='get_my_balance_derived')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='family_ledger_summary')
             AND (SELECT count(*) FROM pg_proc
                   WHERE prosrc LIKE '%LEDGER_WRAPPER_V173%') = 1
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'the parent balance refuses an incomplete ledger',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='family_has_tuition_entry')
             AND (SELECT prosrc FROM pg_proc WHERE proname='get_my_balance' LIMIT 1)
                 LIKE '%ledgerIncomplete%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'an unenrolled camper disconnects the parent from live features',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='link_parent_invites'
                            AND column_name='camp_connected')
             AND (SELECT prosrc FROM pg_proc WHERE proname='submit_parent_message' LIMIT 1)
                 LIKE '%camp_connected%'
             AND (SELECT prosrc FROM pg_proc WHERE proname='revoke_orphaned_parent_invites' LIMIT 1)
                 LIKE '%camp_connected%'
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'a chargeback moves the money back',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='record_chargeback')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='resolve_chargeback')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='flag_plan_collection')
            THEN 'OK' ELSE 'MISSING' END
-- 177 on top of 175: a processor that identifies the transaction but not its
-- value (Cardknox's postback has no amount field) must still be recordable.
UNION ALL SELECT 'a chargeback records even without an amount',
       CASE WHEN (SELECT prosrc FROM pg_proc WHERE proname='record_chargeback' LIMIT 1)
                 LIKE '%amount_unknown%'
             AND (SELECT prosrc FROM pg_proc WHERE proname='record_chargeback' LIMIT 1)
                 NOT LIKE '%bad_amount%'
            THEN 'OK' ELSE 'MISSING' END
-- A processor is only connectable once it declares everything money needs. The
-- second half checks the gate is actually attached: the functions existing with
-- no trigger on camp_processor_credentials is a contract nothing enforces.
UNION ALL SELECT 'a processor must be able to hand money back',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='processor_conformance')
             AND EXISTS (SELECT 1 FROM pg_proc WHERE proname='processor_required_capabilities')
             AND EXISTS (SELECT 1 FROM pg_trigger
                          WHERE tgname='trg_processor_conformance' AND NOT tgisinternal)
            THEN 'OK' ELSE 'MISSING' END
-- And every processor a camp could actually be on must pass it. A row failing
-- here means that processor can no longer be connected — fix the declaration or
-- the code, do not remove the gate.
UNION ALL SELECT 'every live processor conforms',
       CASE WHEN NOT EXISTS (
                SELECT 1 FROM payment_processor_catalog
                 WHERE active AND key <> 'none'
                   AND NOT COALESCE((processor_conformance(key)->>'ok')::boolean, false))
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'camp shop settles its orders',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='settle_shop_order')
            THEN 'OK' ELSE 'MISSING' END
UNION ALL SELECT 'lost-charge reconciliation report',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname='reconcile_processor_charges')
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
