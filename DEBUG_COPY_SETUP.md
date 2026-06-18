# Debug Copy — Setup & Usage

A platform super-admin tool that clones **any** camp into a brand-new sandbox
camp on your own account. You can then edit/generate on the copy freely. The
original camp is only ever **read** — never written.

## One-time setup

1. Open the **Supabase SQL editor** for the project.
2. Run `migrations/010_super_admin_debug_clone.sql`.
   - It creates `super_admins` + `active_camp_selection`, adds **read-only**
     super-admin SELECT policies on the camp tables, redefines
     `get_user_camp_id()` / `get_user_role()` (a backward-compatible superset),
     and grants `yisrose35@gmail.com` super-admin.
   - To change the owner account, edit the email in **two places**: the
     `allowed_email` in the trigger (step 6) and the grant `WHERE` (step 7).
2b. Run `migrations/011_super_admin_camp_create_bypass.sql`.
   - The `camps` INSERT trigger normally requires the owner to have a valid
     access code in their signup metadata. This lets super-admins create camps
     (debug copies) without one; normal signups still require a valid code.
3. Verify: `SELECT * FROM public.super_admins;` should list exactly your account.

## Who can be super-admin

Locked to a single account by design:

- `super_admins` has RLS on with **no** insert/update/delete policy, so no
  logged-in user can grant themselves super-admin through the app or API — there
  is no "become super-admin" path anywhere in the UI.
- A database trigger (`enforce_single_super_admin`) rejects any row whose user
  isn't `yisrose35@gmail.com` — even a service-role/SQL-editor insert. Adding a
  second super-admin is impossible without first explicitly dropping that
  trigger.

## Using it

1. Log into your own account and open the **Dashboard**. A **🧬 Debug Copy**
   panel appears (only for super-admins).
2. Find the camp you want to debug and click **Make a copy**. It reads the
   original and creates `[COPY] <name> — <timestamp>` on your account, then
   switches you into the copy and reloads.
3. Work on the copy anywhere in the app (Me / Flow / generation / print) exactly
   as if it were yours. Nothing you do touches the original.
4. To go back, use **↩ Return to my camp** in the same panel. To switch between
   your real camp and copies, use the **Switch** buttons.
5. To clean up, click **Delete** on a `[COPY]` camp.

## Safety model

- The original is read via additive **SELECT-only** RLS policies. There is no
  super-admin write policy, so the database itself refuses any write to a camp
  you don't own — the original is structurally untouchable from this flow.
- The copy is a normal camp you own, so your existing owner permissions apply to
  it and it is fully isolated.
- Which camp your writes target is decided by `active_camp_selection`, honored
  only for camps you actually own or belong to.
