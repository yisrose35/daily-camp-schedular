#!/usr/bin/env node
/**
 * Generate migrations/159_access_registry_tables.sql from the capability
 * registry in campistry_capabilities.js.
 *
 * WHY THIS IS GENERATED: phase 3 enforces a STAFF MEMBER's section access in
 * RLS, not just in the browser. To do that the database has to know two things
 * that until now existed only as JavaScript:
 *
 *   1. the capability registry  — which app/section each key belongs to, and
 *                                 whether it is view-only
 *   2. the preset expansions    — what 'nurse' or 'bookkeeper' actually grants,
 *                                 after '*' and 'app.*' are resolved
 *
 * Hand-transcribing either into SQL would create a second source of truth, and
 * the two would drift. Drift here does not cause a visible bug — it silently
 * locks the wrong people out, or silently grants access. So the SQL is
 * generated from the JS, and a test (tests/access_registry_sql.test.js) fails
 * if the checked-in SQL no longer matches the registry.
 *
 * Re-run after ANY change to C.CAPABILITIES or C.PRESETS:
 *
 *     node scripts/build-access-registry-sql.js
 *
 * ── the `explicit` column ──────────────────────────────────────────────────
 * C.resolve has one rule that needs the RAW grants object, not the expansion:
 * 'finance' was split out of what used to be a single 'analytics' capability,
 * so a preset that does not NAME 'me.finance' resolves it as 'me.analytics'
 * instead of treating it as an unlisted key. `explicit` records whether the
 * preset literally named that key, which is what `hasOwnPresetGrant` tests.
 * Without it, everyone configured before the split silently loses Finance.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.dirname(__dirname);
const C = require(path.join(REPO, 'campistry_capabilities.js'));
const OUT = path.join(REPO, 'migrations', '159_access_registry_tables.sql');

const q = s => "'" + String(s).replace(/'/g, "''") + "'";

function build() {
    const caps = C.all().slice().sort((a, b) => a.key.localeCompare(b.key));
    const presets = C.PRESETS.slice().sort((a, b) => a.key.localeCompare(b.key));

    const capRows = caps.map(c =>
        `    (${q(c.key)}, ${q(c.app)}, ${q(c.section)}, ${c.viewOnly ? 'true' : 'false'})`);

    const grantRows = [];
    for (const p of presets) {
        const expanded = C.expandPreset(p.key);
        const raw = p.grants || {};
        for (const c of caps) {
            const explicit = Object.prototype.hasOwnProperty.call(raw, c.key);
            grantRows.push(
                `    (${q(p.key)}, ${q(c.key)}, ${q(expanded[c.key])}, ${explicit ? 'true' : 'false'})`);
        }
    }

    // A truth table the user can run against the live database and eyeball.
    // Generated from the real resolver so it cannot be wrong, and limited to the
    // two capabilities phase 3 actually gates.
    const mk = (role, preset) => ({ role, products: null, preset: preset || null, overrides: {}, entitlements: {} });
    const truth = [];
    for (const cap of ['me.payroll', 'me.finance']) {
        for (const role of ['owner', 'admin']) {
            truth.push(`--   ${cap.padEnd(11)} role=${role.padEnd(8)} (no preset)        -> ${C.resolve(cap, mk(role))}`);
        }
        for (const p of presets) {
            truth.push(`--   ${cap.padEnd(11)} role=manager  preset=${p.key.padEnd(16)} -> ${C.resolve(cap, mk('manager', p.key))}`);
        }
    }

    return `-- ============================================================================
-- Migration 159: the capability registry and preset expansions, in SQL.
--
-- GENERATED FILE — do not edit by hand.
-- Rebuild with:  node scripts/build-access-registry-sql.js
--
-- Phase 3 of ENTITLEMENTS_DESIGN.md enforces a STAFF MEMBER's section access in
-- RLS. Until now that layer was browser-only: a manager with payroll:none could
-- read campistryMePayroll straight out of the table with curl. To close that,
-- the database needs the two things that only existed as JavaScript — the
-- capability registry, and what each preset expands to once '*' and 'app.*' are
-- resolved.
--
-- These tables are DERIVED DATA, not configuration. Nobody edits them; they are
-- regenerated from campistry_capabilities.js, which stays the single source of
-- truth. tests/access_registry_sql.test.js fails if this file drifts from it.
--
-- Read-only to clients: RLS denies everything and the resolver reads them as
-- SECURITY DEFINER. They are not camp data — they are the same for every camp.
--
-- Idempotent: the tables are recreated and refilled from scratch each run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS access_capabilities (
    cap_key    text PRIMARY KEY,
    app        text NOT NULL,
    section    text NOT NULL,
    view_only  boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS access_preset_grants (
    preset     text NOT NULL,
    cap_key    text NOT NULL,
    level      text NOT NULL,
    -- Did the preset literally NAME this key, as opposed to inheriting the
    -- level from 'app.*' or '*'? Needed for the finance -> analytics legacy
    -- fallback in user_section_level(); see the header of the generator.
    explicit   boolean NOT NULL DEFAULT false,
    PRIMARY KEY (preset, cap_key)
);

-- Neither table is camp-scoped and neither is client-readable. The resolver is
-- SECURITY DEFINER, so it sees them regardless.
ALTER TABLE access_capabilities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_preset_grants ENABLE ROW LEVEL SECURITY;

-- Refill from scratch, so a removed capability or preset actually disappears
-- rather than lingering and granting access to a section that no longer exists.
TRUNCATE access_preset_grants;
TRUNCATE access_capabilities;

INSERT INTO access_capabilities (cap_key, app, section, view_only) VALUES
${capRows.join(',\n')};

INSERT INTO access_preset_grants (preset, cap_key, level, explicit) VALUES
${grantRows.join(',\n')};

-- ─── Verification ──────────────────────────────────────────────────────────
--   select count(*) from access_capabilities;    -- expect ${caps.length}
--   select count(*) from access_preset_grants;   -- expect ${grantRows.length}
--
-- Resolved levels for the two capabilities phase 3 gates, straight from the
-- JavaScript resolver. After applying 160, user_section_level() must agree with
-- every line of this:
${truth.join('\n')}
--
-- NOTE 'me.finance' never exceeds 'view' for ANYONE, the owner included — it is
-- flagged view-only in the registry. That is why migration 160 gates writes on
-- "not none" rather than "edit": gating on edit would make Finance permanently
-- unsaveable for every user in every camp.
-- ============================================================================
`;
}

const sql = build();
fs.writeFileSync(OUT, sql, 'utf8');
console.log('Wrote %s (%d bytes)', path.relative(REPO, OUT), sql.length);

module.exports = { build };
