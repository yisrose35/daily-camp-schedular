# Canteen "Sold Today" Counters — Setup

Fixes the Snacks dashboard disagreeing with its own Menu Items tab.

## The problem

`campistrySnacks` carries two counters that describe **today**:

- `inventory[].soldToday` — the Menu Items tab's "Sold Today" column, and the
  dashboard's "Top Seller … N today" and "Units Sold" tiles
- `hourlyActivity` — the Analytics tab's by-hour chart

Nothing ever reset either one. (`account.spentToday` has always rolled over off
its own `lastSpendDate` stamp — these two were simply never given the same
treatment.) So they accumulated for the life of the camp, while the dashboard's
**Revenue Today** and **txns** tiles read from `transactions` filtered to
`date === today` and reported the real figure.

The two then disagreed by however many days the counters had been running.
Observed live: a dashboard reading **$8.00 / 3 txns** sitting directly above a
Menu Items table whose own per-item "Sold Today" counts added up to **$31.75**.
The dashboard was right; the item counters were stale.

## The fix

The blob now carries a `countersDay` stamp (`YYYY-MM-DD`). When it doesn't match
the current day, `soldToday` is zeroed on every item and `hourlyActivity` is
cleared, then the stamp is advanced.

The manager page (`campistry_snacks.js`) and the register (`campistry_snacks_pos.js`)
both do this locally. But the register's sale path deliberately **does not write
the blob** — migration 142 moved it to sending inventory deltas through
`record_canteen_sale_inventory()` precisely so a blind upsert from the POS can't
clobber a concurrent, row-locked balance write. That means a register making the
day's first sale would have its locally-rolled zero ignored, and the delta would
land on top of yesterday's server-side total.

So the rollover also has to happen **inside that RPC**, under the same
`FOR UPDATE` row lock that applies the deltas. That's what the migration below
does.

## One-time setup (Supabase Dashboard — no CLI needed)

### Run the migration

Dashboard → **SQL Editor** → **New query** → paste the full contents of
`migrations/145_canteen_daily_counter_rollover.sql` from this repo → **Run**.

It drops the three-argument `record_canteen_sale_inventory()` from migration 142
and recreates it with a fourth argument, `p_day`, then re-grants EXECUTE to
`authenticated`. The drop is what keeps a three-argument call unambiguous — with
both versions present, PostgreSQL would have two candidates to choose from.

You should see `Success. No rows returned`.

### Verify

Dashboard → **SQL Editor**, and check the function now takes four arguments:

```sql
SELECT p.oid::regprocedure AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'record_canteen_sale_inventory';
```

Expected — exactly one row:

```
record_canteen_sale_inventory(uuid,jsonb,integer,text)
```

If you see two rows, the old three-argument version is still there; re-run the
`DROP FUNCTION` line at the top of the migration on its own.

## If you don't run the migration

Nothing breaks. `p_day` defaults to `NULL`, which means "don't roll", so the
function behaves exactly as it did under migration 142. The register also
retries without `p_day` if the four-argument call is rejected, so a sale's
inventory delta is still recorded either way.

What you'd lose is only the server-side half of the rollover: the manager page
still rolls and saves its own counters, but a register that makes the first sale
of a new day before the manager page has been opened would add that sale on top
of the previous day's server-side total, and the counts would drift again.

## What was NOT changed

- `totalSold` is all-time by design and still accumulates forever.
- `transactions` is append-only and untouched — the revenue figures were always
  correct, and every historical day's sales remain fully reconstructable from
  the ledger.
- No counter is zeroed on the strength of a *missing* `countersDay`. A blob that
  has never carried the stamp (i.e. every camp, until this ships) is simply
  stamped with today's date: those counts may well be from today, and throwing
  away a real day's numbers to fix a reporting bug would be the worse trade.
  The first genuine rollover happens at the next date change.
