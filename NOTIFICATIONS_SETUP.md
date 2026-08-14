# Campistry Notifications — setup

The Dashboard's live "Notifications & Reminders" feed — new Campistry Link
messages and due Campistry Notes reminders show up there automatically. Most
of it is already wired; this is the one-time deploy.

## What exists

| Source | How it reaches the feed | Auto-records? |
|---|---|---|
| New inbound message on **Campistry Link** | A database trigger on `link_messages` fires the moment a parent's reply lands | ✅ (trigger) |
| A **Campistry Notes** reminder/timer coming due | A scheduled scan checks every camp's notes on an interval | ✅ (cron) |

Both write into one `notifications` table, which the Dashboard reads from
directly and subscribes to over Supabase Realtime — no polling required for
Link messages (the trigger fires instantly); Notes reminders are only as
prompt as the scan interval (below).

## How it reaches the Dashboard

1. A parent replies on Campistry Link → `submit_message_reply` inserts into
   `link_messages` → `trg_notify_new_link_message` fires → a row lands in
   `notifications` → every Dashboard tab with that camp open gets it
   over Realtime within moments.
2. A Campistry Notes reminder's date/time passes → the next
   `check-notes-reminders` run notices it (comparing UTC "now" against the
   reminder's stored date/time — see the limitation note in the function's
   own comment) → inserts into `notifications` → same Realtime delivery.

## One-time setup

### 1. Apply the migration
Run `migrations/056_notifications.sql` in the Supabase SQL editor. This
creates `notifications` + `notification_reads`, their RLS policies, the
`link_messages` trigger, and adds `notifications` to the realtime
publication.

### 2. Deploy the edge function
```bash
supabase functions deploy check-notes-reminders
```
(No new function is needed for Link messages — that's a database trigger,
already live once the migration is applied.)

### 3. Set the cron secret
```bash
supabase secrets set NOTES_REMINDER_CRON_SECRET=<a-long-random-string>
```

### 4. Schedule it with pg_cron
Enable the `pg_cron` and `pg_net` extensions first (Database → Extensions),
then run in the SQL editor, filling in your project ref and the same secret:
```sql
select cron.schedule(
  'campistry-notes-reminders',
  '*/5 * * * *',                       -- every 5 minutes
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/check-notes-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<NOTES_REMINDER_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```
You can trigger a run manually by POSTing to the function with the
`x-cron-secret` header, same as `charge-due-installments`.

## Notes / follow-ups
- Who sees the feed: `notifications` RLS mirrors `link_messages` —
  owner/admin/scheduler roles only. Other roles simply get an empty feed,
  no extra gating needed on the Dashboard side.
- Read state is per-user (`notification_reads`), so two staff on the same
  camp track "seen" independently.
- Reminder timing is UTC-compared against a plain date/time string with no
  stored timezone (same limitation the rest of the app has for date-only
  fields like installment due dates) — a reminder can fire up to several
  hours off from the camp's local time. Tightening this would mean storing
  the camp's timezone somewhere; not done in this pass.
- Want another source feeding the same table later (e.g. a bus delay, a
  form submission)? Insert into `notifications` the same way the trigger
  does — `camp_id`, `source`, a stable `source_id` for dedup, `title`,
  `body`, `link_target`.
