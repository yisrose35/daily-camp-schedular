# Campistry Scheduled Reports — setup

Reports built in Me's Report Builder can be set to email themselves to a
recipient list on a Weekly or Monthly cadence. Most of it is already wired;
this is the one-time deploy.

## What it does — and doesn't do

| | |
|---|---|
| **Does** | Emails recipients a "your report is ready" notification (subject + a short pointer back to Me) on the configured cadence |
| **Doesn't** | Regenerate the report server-side, attach a CSV, or send the actual rows by email — recipients open Campistry Me → Reports to see live data |

That scope is deliberate: replicating the client-side report builder's
filter/grouping engine in a Deno function would duplicate significant logic
for a feature most camps will use as a lightweight reminder, not a data feed.

## How it works

1. In Me → Reports, click **Build Report** (or **Edit** on an existing one),
   set **Email this report** to Weekly or Monthly, and add one or more
   recipient emails (comma-separated). Save.
2. The schedule is stored on the report itself — `campistryMe.savedReports[].schedule
   = {freq, recipients, lastSentAt}` — inside the same `camp_state_kv` blob
   everything else in Me lives in. No new table.
3. On each `send-scheduled-reports` run, every camp's saved reports are
   scanned; a report is **due** if it's never been sent, or if `now -
   lastSentAt` has passed the cadence (7 days for weekly, ~28 for monthly).
4. Due reports get delivered via the existing `send-broadcast` function
   (same Resend-backed sender Broadcasts already use), then `lastSentAt` is
   stamped back onto the report so the next scan skips it until due again.

## One-time setup

### 1. Deploy the edge function
```bash
supabase functions deploy send-scheduled-reports
```
No migration is needed — this reads/writes the existing `camp_state_kv`
table, same as every other Me feature.

### 2. Set the cron secret
```bash
supabase secrets set SCHEDULED_REPORTS_CRON_SECRET=<a-long-random-string>
```

### 3. Schedule it with pg_cron
Enable the `pg_cron` and `pg_net` extensions first (Database → Extensions),
then run in the SQL editor, filling in your project ref and the same secret.
Once a day is enough — a weekly/monthly cadence doesn't need finer polling:
```sql
select cron.schedule(
  'campistry-scheduled-reports',
  '0 13 * * *',                        -- once daily, 1pm UTC
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-scheduled-reports',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<SCHEDULED_REPORTS_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```
You can trigger a run manually by POSTing to the function with the
`x-cron-secret` header, same as `check-notes-reminders`.

## Notes / follow-ups
- "Monthly" is approximated as 28 days, not calendar-month math — same
  spirit as `check-notes-reminders`' own documented date-string shortcut.
  Tightening this to actual calendar months is a follow-up, not a blocker.
- The write-back that stamps `lastSentAt` re-reads the camp's current
  `campistryMe` value immediately before writing (not the one from the top
  of the scan) to shrink the window where a concurrent office-side save of
  an unrelated field could be reverted. Not eliminated — there's no JSON-patch
  primitive on `camp_state_kv` — just narrowed from "the whole scan" down to
  "this camp's processing time."
- Turning a schedule off (or deleting the report) simply stops it from
  matching on the next scan — no cleanup step needed.
- Changing a report's frequency or recipient list resets `lastSentAt`, so
  the new schedule doesn't silently wait out the old cadence before its
  first send.
