-- 120_user_ui_prefs.sql
-- A small per-USER (not per-camp) preference store — the first of its kind
-- in Campistry. Used for things that should follow one staff member across
-- devices/browsers without affecting anyone else looking at the same camp
-- data, starting with resizable/reorderable table columns on the Reports
-- Builder and Print Sheets preview tables (Me → Reports/Print Sheets).
--
-- Rows are keyed by (user_id, pref_key) — pref_key is a free-form string
-- the client namespaces itself, e.g. 'cols:<campId>:report:<reportId>' or
-- 'cols:<campId>:printsheet:<sheetId>'. RLS alone is the full access
-- control here (a user can only ever read/write their own rows) — no
-- SECURITY DEFINER RPC layer is needed since nothing here is camp-shared
-- or needs a server-side authorization check beyond "is this your own row."
--
-- Paste this whole file into the Supabase SQL Editor and run it.

CREATE TABLE IF NOT EXISTS public.user_ui_prefs (
    user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    pref_key   text NOT NULL,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, pref_key)
);

ALTER TABLE public.user_ui_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_ui_prefs_own ON public.user_ui_prefs;
CREATE POLICY user_ui_prefs_own ON public.user_ui_prefs
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_ui_prefs TO authenticated;

-- Verify after running:
--   SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'user_ui_prefs';
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'user_ui_prefs';
