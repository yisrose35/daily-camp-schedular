-- ═══════════════════════════════════════════════════════════════════════
-- 008 — Cross-camp specials contamination: DETECTOR + CLEANER (admin tools)
-- ═══════════════════════════════════════════════════════════════════════
-- NOT an auto-run migration. These are operator tools, run in the Supabase
-- SQL editor by the platform owner. Background: the browser-wide local
-- settings cache used to merge one camp's config into another camp's cloud
-- (fixed forward by the camp-stamp guard, integration_hooks.js). Camps
-- created BEFORE the guard may still hold another camp's special
-- activities. Code cannot decide which entries are foreign (no authorship
-- metadata) — a human confirms per camp; the CLEANER then strips them and
-- seeds deletion TOMBSTONES so every device of that camp self-heals on its
-- next load (special_activities.js drops tombstoned names on load, and a
-- stale device cache can never resurrect them).
--
-- Usage:
--   1) Run DETECTOR A. Rows with distinct_configs = 1 are byte-identical
--      entries shared across camps — near-certain contamination (rich
--      configs don't coincide byte-for-byte). Same NAME with different
--      configs in different camps is usually legitimate.
--   2) For each flagged camp, run DETECTOR B to see its full list and
--      confirm with knowledge of that camp which names are foreign.
--   3) Edit the two marked lines in CLEANER and run it once per camp.
--      Requires the tombstone-aware bundle (special_activities.js with
--      deletedSpecials support) to be DEPLOYED to the environment that
--      camp uses — the cloud rows update immediately; devices self-heal
--      on next page load.
-- ═══════════════════════════════════════════════════════════════════════

-- ── DETECTOR A: special entries shared across camps ─────────────────────
with specs as (
    select camp_id,
           lower(trim(x->>'name')) as name_key,
           x as entry
    from camp_state_kv,
         lateral jsonb_array_elements(value->'specialActivities') x
    where key = 'app1'
      and jsonb_typeof(value->'specialActivities') = 'array'
      and x ? 'name'
)
select name_key,
       count(distinct camp_id)                as camps,
       array_agg(distinct camp_id::text)      as camp_ids,
       count(distinct entry::text)            as distinct_configs  -- 1 = byte-identical everywhere → contamination signal
from specs
group by name_key
having count(distinct camp_id) > 1
order by distinct_configs asc, camps desc, name_key;

-- ── DETECTOR B: one camp's full specials inventory (both stores) ─────────
-- select key,
--        (select array_agg(x->>'name')
--           from jsonb_array_elements(case when key = 'app1' then value->'specialActivities' else value end) x
--        ) as special_names
-- from camp_state_kv
-- where camp_id = 'PASTE-CAMP-ID'
--   and key in ('app1', 'specialActivities');

-- ── CLEANER: strip foreign specials + seed tombstones for ONE camp ──────
-- Edit the two <<< lines, then run the whole block.
-- do $$
-- declare
--     cid           uuid   := 'PASTE-CAMP-ID';                          -- <<< camp to clean
--     foreign_names text[] := array['canteen','gameroom'];              -- <<< lowercased foreign names
--     tomb          jsonb;
-- begin
--     select coalesce(jsonb_object_agg(n, (extract(epoch from now()) * 1000)::bigint), '{}'::jsonb)
--       into tomb
--       from unnest(foreign_names) n;
--
--     -- 1) top-level specialActivities array
--     update camp_state_kv
--        set value = coalesce(
--                (select jsonb_agg(x)
--                   from jsonb_array_elements(value) x
--                  where not (lower(trim(x->>'name')) = any(foreign_names))),
--                '[]'::jsonb),
--            updated_at = now()
--      where camp_id = cid
--        and key = 'specialActivities'
--        and jsonb_typeof(value) = 'array';
--
--     -- 2) app1.specialActivities + merge tombstones into app1.deletedSpecials
--     update camp_state_kv
--        set value = jsonb_set(
--                jsonb_set(value, '{specialActivities}',
--                    coalesce(
--                        (select jsonb_agg(x)
--                           from jsonb_array_elements(value->'specialActivities') x
--                          where not (lower(trim(x->>'name')) = any(foreign_names))),
--                        '[]'::jsonb)),
--                '{deletedSpecials}',
--                coalesce(value->'deletedSpecials', '{}'::jsonb) || tomb),
--            updated_at = now()
--      where camp_id = cid
--        and key = 'app1'
--        and jsonb_typeof(value->'specialActivities') = 'array';
--
--     -- 3) top-level deletedSpecials row (durable tombstone anchor; upsert)
--     insert into camp_state_kv (camp_id, key, value, updated_at)
--     values (cid, 'deletedSpecials', tomb, now())
--     on conflict (camp_id, key)
--     do update set value = coalesce(camp_state_kv.value, '{}'::jsonb) || excluded.value,
--                   updated_at = now();
-- end $$;

-- Self-heal model after CLEANER runs: cloud rows carry the cleaned arrays +
-- tombstones with fresh updated_at. A device with a stale local cache may
-- briefly re-merge the old array, but the deployed load path drops every
-- tombstoned name on read and the next save persists the cleaned arrays —
-- the top-level deletedSpecials row survives any app1-key overwrite because
-- tombstones are read as the UNION of both stores. Schedules already
-- generated with a foreign special are fixed by regenerating that day.
