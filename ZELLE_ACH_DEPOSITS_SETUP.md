# Zelle & ACH tuition — automatic capture

Tuition paid by Zelle or ACH lands in the camp's bank account and, until now,
had to be read off a statement and retyped into **Billing → Record Payment**.
This feature books it automatically, the moment the bank says it arrived.

---

## Why it works this way

**Zelle has no merchant API.** It is bank-to-bank with no merchant layer to
integrate against, and a plain ACH credit has no callback either. So there is
no "connect Zelle to Campistry" button to build — the only things in the world
that can report an incoming deposit are:

1. **the alert email the camp's own bank sends** (seconds after it lands), and
2. **the transaction descriptor** on the statement or a bank data feed.

This setup wires up (1). It needs no bank integration, no aggregator contract,
and works at *any* bank, including ones no data aggregator supports.

**The other half of the problem is the name.** The name on a Zelle payment is
frequently not the name on the family record — a father's business, a mother's
maiden name, a grandparent, a second parent with a different surname. Campistry
handles that with two things:

- **Memo codes** — a short per-family code (`KLE-6014`) the parent puts in the
  Zelle memo. It identifies the family directly, so the payer's name stops
  mattering at all.
- **Payer aliases** — "SHIMON'S HARDWARE LLC is the Klein family," resolved by
  a human **once** and remembered forever. This is what turns the name mismatch
  from a recurring chore into a one-time click per payer.

---

## What arrives where

```
Bank sends deposit alert
        ↓
deposits+<token>@<your inbound domain>     ← Resend receives it
        ↓  email.received webhook
deposit-inbox  (Supabase edge function)
        ↓  verify → parse → match → decide
bank_deposits table
        ↓
  ≥90 confidence → posted straight to the family ledger
  40–89          → reconcile inbox, one click (and it learns an alias)
  <40            → unmatched, visible and actionable
```

Deposits live in `bank_deposits`, **not** in the `camp_state_kv` blob where the
rest of the finance data sits. That is deliberate — see the header of
`migrations/145_bank_deposits.sql`. Short version: the blob has exactly one
writer (the browser, which rewrites the whole object on every save), and a
webhook appending to it would have its payments silently overwritten by any
office tab that loaded the page a few minutes earlier.

---

## One-time setup

### 1. Apply the migration

Supabase Dashboard → **SQL Editor** → paste the entire contents of
`migrations/145_bank_deposits.sql` → **Run**. It is idempotent, so re-running it
is safe.

This creates `bank_deposits`, `payer_aliases`, `camp_deposit_settings`,
`family_balance_snapshots`, and the RPCs the app calls.

### 2. Deploy the edge function

Supabase Dashboard → **Edge Functions** → **Deploy a new function**.

- Name: `deposit-inbox`
- Verify JWT: **OFF** — Resend is not a Supabase caller. The function
  authenticates the request itself (three separate checks, below).

It needs two files:

| Path in the function | Source file in this repo |
|---|---|
| `index.ts` | `supabase/functions/deposit-inbox/index.ts` |
| `../_shared/deposit_core.ts` | `supabase/functions/_shared/deposit_core.ts` |

> `_shared/deposit_core.ts` is **generated** from `campistry_deposit_parser.js`
> and `campistry_deposit_match.js` — do not hand-edit it. Change the root files
> and run `node tools/build_deposit_core.js`. `tests/deposit_core_sync.test.js`
> fails if the copy goes stale, which is what stops the server from silently
> enforcing different matching rules than the browser shows.

### 3. Set the secrets

Supabase Dashboard → **Edge Functions → Secrets**:

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | your existing Resend key (already used by `send-invite-email`) |
| `RESEND_WEBHOOK_SECRET` | the `whsec_…` from step 5 below |
| `RESEND_RECEIVING_URL` | *optional* — only if step 6 shows a different endpoint |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 4. Turn on inbound email in Resend

Resend Dashboard → **Inbound**. Two options:

- **Managed address** — `<alias>@<id>.resend.app`, needs **no DNS at all**.
  Fastest way to pilot this.
- **Your own domain** — add a single **MX record on the `inbound` subdomain**
  (e.g. `inbound.campistry.com`). Nicer to hand to a camp.

### 5. Register the webhook

Resend Dashboard → **Webhooks** → add an endpoint:

- URL: `https://<your-project>.supabase.co/functions/v1/deposit-inbox`
- Event: **`email.received`**
- Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET` (step 3).

### 6. ⚠️ Confirm the payload shape with one live delivery

**Do this before letting any camp rely on it.** Resend's `email.received`
payload carries **metadata only** — the body is fetched separately — and its
exact field names are not fully documented publicly. `deposit-inbox` therefore
accepts several plausible spellings and fetches the body from
`https://api.resend.com/emails/receiving/<id>`.

Send one real bank alert to the address, then open **Edge Functions → Logs**:

- A line like `camp <id>: $850 from "SHIMON'S HARDWARE LLC" -> posted` means
  everything resolved correctly. Done.
- `no_routing_token` → the To: address isn't reaching the function in a field
  we read. Check the logged addresses.
- A `body fetch 404` warning → the receiving endpoint differs; set
  `RESEND_RECEIVING_URL` to the correct base URL and redeploy.

---

## Per-camp configuration

Each camp gets its own routing token, minted the first time its settings are
read (`get_camp_deposit_settings`). The camp's address is:

```
deposits+<inbound_token>@<your inbound domain>
```

### Point the bank at it

In the camp's online banking, create an alert for **incoming deposits /
transfers received** and set the delivery address to the one above. Where the
bank supports it, enable the Zelle-specific "money received" alert too — those
are the ones that carry the memo.

| Bank | Where |
|---|---|
| Chase | Profile & settings → Alerts → Accounts → *Deposit posted* / *Zelle payment received* |
| Bank of America | Alerts → Account activity → *Deposits and credits* |
| Wells Fargo | Alerts → Balance & activity → *Deposit posted* |
| Citi | Alerts → Account alerts → *Deposit or credit posted* |
| Capital One | Settings → Alerts → *Money received* |

Most banks send alerts to the account holder's email only. If the camp cannot
add a second address, have them set a **forwarding rule** from that mailbox to
the Campistry address instead — it works identically.

### Lock down the sender

Set `sender_allowlist` to the bank's sending domain (e.g. `chase.com`,
`alerts.chase.com`). Until it is set, **any** email reaching the address is
accepted, which is only reasonable while testing.

### Start in dry run

`dry_run` defaults to **true**: deposits are matched, ranked and explained, but
nothing posts to a ledger. Leave a camp there for the first week or two so the
office can watch it be right before trusting it. This is the single most
important thing for getting a camp to actually adopt it.

---

## Security

This endpoint creates money, so it is public but triple-checked. **All three
are required** and none of them should be relaxed to make testing easier — use
a test camp instead.

1. **Svix signature** over the raw body (HMAC-SHA256 of
   `svix-id.svix-timestamp.body`), with a 5-minute replay window. A missing
   `RESEND_WEBHOOK_SECRET` makes the function refuse everything rather than
   accept unverifiable mail.
2. **Routing token** in the To: address — a per-camp secret, rotatable via
   `set_camp_deposit_settings(p_rotate_token => true)` without touching DNS.
3. **Sender allowlist** — the From: domain must be the camp's bank.

`_deposit_record` and `_deposit_camp_for_token` are explicitly revoked from
`anon` and `authenticated`; only the service role can call them. A client that
could call `_deposit_record` could invent tuition payments.

---

## What it refuses to do by itself

The matcher is far more willing to demote a match than to make one, because a
deposit sent to review costs one click while a deposit posted to the *wrong*
family corrupts two ledgers and stays invisible until statements go out.

| Situation | What happens |
|---|---|
| Outbound payment or a payment *request* alert | Discarded before an amount is even read |
| Two families match about equally | Review, naming both |
| More than the family's balance | Review — usually a wrong match, not a prepayment |
| Return / NSF reversal | Always a human |
| Dry run on | Everything to review, with the answer still shown |
| Payer unreadable | Captured anyway, as `unmatched` — the money is real |

Every auto-post records its confidence and reasons and is reversible via
`unmatch_bank_deposit`.

---

## Still to wire up

- **Billing UI** — the reconcile inbox, the alias manager, and the memo code on
  statements/invoices. The RPCs are all in place (`get_bank_deposits`,
  `resolve_bank_deposit`, `ignore_bank_deposit`, `unmatch_bank_deposit`,
  `get_payer_aliases`, `add_payer_alias`, `get_camp_deposit_credits`).
- **Ledger union** — Billing must add `get_camp_deposit_credits` to what it
  reads out of `camp_state_kv`. Until it does, posted deposits sit in
  `bank_deposits` without showing on the family ledger.
- **`get_my_balance`** — the parent-facing balance in Campistry Link reads only
  the kv blob, so a parent will not see an auto-posted deposit until that
  function unions the same source (migrations 046 / 096 / 118).
- **Balance snapshot publish** — Billing should call
  `set_family_balance_snapshot` with what `buildFamilyLedgers()` already
  computed, which switches the overpay guardrail on.
- **Bank data feed (Teller/Plaid)** — the second, authoritative feed:
  backfills history, catches alerts that were missed or turned off, and reports
  ACH returns. The fingerprint already dedupes it against the email feed.
