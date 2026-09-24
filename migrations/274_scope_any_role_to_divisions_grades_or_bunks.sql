-- ============================================================================
-- Migration 274: scope ANY team member to specific divisions, grades, or
-- bunks — not just schedulers, and not only whole named division groups.
--
-- WHY. Division scoping already existed, but only two ways:
--   1. camp_users.assigned_divisions (a flat text[] of division names), and
--   2. camp_users.subdivision_ids pointing at named `subdivisions` rows,
--      whose own `divisions` column supplied the actual names.
-- Both are DIVISION-granularity only, and both required first creating a
-- named, reusable "division group" before assigning anyone to it — real
-- overhead for the common case of "this one manager, just for Junior
-- division." Neither goes finer than a whole division: a grade or a single
-- bunk was never expressible.
--
-- WHAT THIS ADDS. camp_users.data_scope (jsonb), written directly by the
-- Invite/Edit Team Member forms (team_subdivisions_ui.js) — no RPC, matching
-- how assigned_divisions/product_access are already written today (plain
-- client .insert()/.update() on camp_users, gated by the existing RLS
-- policies on that table, which are row-level and don't need to know about
-- this new column). Shape:
--   {"type": "all"}
--   {"type": "divisions", "divisions": ["Seniors", ...]}
--   {"type": "grades",    "grades":    [{"division": "Seniors", "grade": "Grade 8"}, ...]}
--   {"type": "bunks",     "bunks":     [{"division": "Seniors", "grade": "Grade 8", "bunk": "Bunk 1"}, ...]}
-- NULL/{"type":"all"} = unrestricted, matching how an unconfigured member
-- works everywhere else in the access system (fail-open to "no limit" is
-- the existing convention, not a new one introduced here).
--
-- BACKWARD COMPATIBILITY. assigned_divisions is NOT replaced or migrated —
-- it's still written alongside data_scope (as the flattened list of parent
-- divisions for a grades/bunks scope) so every existing consumer that only
-- knows how to read assigned_divisions (getUserAssignedDivisions() in
-- permissions_guard.js, and everything downstream of it) keeps working
-- unchanged. data_scope is additive: new, finer-grained consumers read it
-- directly; old ones keep reading assigned_divisions exactly as before.
--
-- NO RLS CHANGE NEEDED. This mirrors assigned_divisions/product_access,
-- neither of which has ever had a dedicated RLS policy (confirmed: no
-- migration references assigned_divisions in an RLS clause) — division/
-- grade/bunk scoping in this app has always been a CLIENT-SIDE filtering
-- concern (what's shown/generated), not a database security boundary, and
-- this column follows that exact same, already-shipped model.
-- ============================================================================

ALTER TABLE public.camp_users
    ADD COLUMN IF NOT EXISTS data_scope jsonb;

COMMENT ON COLUMN public.camp_users.data_scope IS
    'Which part of the camp this person''s access applies to: {"type":"all"} (default/unrestricted), {"type":"divisions","divisions":[...]}, {"type":"grades","grades":[{"division","grade"},...]}, or {"type":"bunks","bunks":[{"division","grade","bunk"},...]}. Written directly by team_subdivisions_ui.js alongside assigned_divisions (kept in sync as the flattened parent-division list for backward compatibility with existing consumers). No RLS references this column — like assigned_divisions before it, this is client-side scoping, not a database security boundary.';
