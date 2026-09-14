# Banquest — redirect-to-hosted-page setup

Campistry never renders a card field for Banquest. The parent (or owner) is
sent to **Banquest's own hosted Payment Page**, enters the card there, and comes
back; Campistry records the result server-side. This is the same "leave, pay,
return" model used for Stripe and Sola.

Because the card is entered on Banquest's page, a few things have to be
configured **in the Banquest dashboard** for the flow to work. This is one-time
per camp.

---

## 1. API base URL (credential)

The Banquest **API** host is different from the dashboard/login host:

| Environment | API base to store as `gatewayUrl` |
|-------------|-----------------------------------|
| Sandbox     | `https://api.sandbox.banquestgateway.com/api/v2` |
| Production  | `https://api.banquestgateway.com/api/v2` |

> The sandbox login page is `sandbox.banquestgateway.com`, but the **API** lives
> at `api.sandbox.banquestgateway.com`. Store the API host. (The edge functions
> defensively append `/api/v2` if you store a bare host, but they cannot fix a
> wrong hostname, so use the values above exactly.)

Connect the camp through `admin-connect-processor` with credentials:
`sourceKey`, `pin`, `tokenizationKey` (`pk_…`), `gatewayUrl` (above),
`paymentPageSlug` (below), and optionally `webhookSignature` (below).

---

## 2. Create a hosted Payment Page (gives you the slug)

In the Banquest dashboard, create a Payment Page. Note its **slug** — that's the
`paymentPageSlug` credential. Campistry pre-fills and redirects to
`POST /payment-pages/generate-pay-link/{slug}`.

The page **must** have these fields enabled, because Campistry sends them and
Banquest returns a **400** if a sent field doesn't exist on the page:

- **`amount`** (general field) — used for tuition payments and canteen deposits.
- **`description`** (general field).
- **Custom fields `custom1`–`custom4`** — Campistry threads its own metadata
  through these so the transaction is traceable:
  - `custom1` = purpose (`save_card` / `pay_now` / `canteen`)
  - `custom2` = family key (tuition) — blank for canteen
  - `custom3` = camper name (canteen) — blank for tuition
  - `custom4` = camp id

  Set them as **hidden** fields on the page.

### Save-card must be enabled on the page
For "save a card" (tuition autopay setup, canteen auto-reload setup) the page
must **save the card to a Customer**. Campistry then reads that customer's
newest card (`GET /customers/{id}/payment-methods`) and stores it as the
reusable token (`pm-<id>`) that autopay/auto-reload charge later. If the page
does not save the card to a customer, save-card returns a clear error and no
token is stored.

> If Banquest offers a separate "verification / $0 save-card" page type, you can
> use a dedicated page for save-card and a normal charge page for payments — but
> today Campistry uses the single `paymentPageSlug` for both. If you need two
> pages, tell me and I'll split the credential into `payNowPageSlug` /
> `saveCardPageSlug`.

---

## 3. (Optional) Webhook — backstop for abandoned returns

The normal flow does **not** need a webhook: when the parent returns, Campistry
looks the transaction up by its one-time `key` (`GET /transactions?key=`) and
records it. A webhook only matters as a backstop for the case where the parent
**closes the tab before returning** even though the payment succeeded.

To register one (from the API, with the camp's own credentials):

```
POST /webhooks
{ "webhook_url": "https://<project-ref>.functions.supabase.co/banquest-webhook",
  "description": "Campistry",
  "events": ["transaction.succeeded"] }
```

The response includes a `signature` — store that as the `webhookSignature`
credential. (The `banquest-webhook` receiver is not deployed yet — see the notes
in the PR/commit; it needs Banquest's webhook *delivery* payload + signature
scheme, which weren't in the API reference. Until then, an abandoned-return
payment stays `pending` in `banquest_pending_links` and can be completed by
re-opening the return link, or reconciled manually.)

---

## 4. Test cards (sandbox)

- Visa `4761530001111118`
- Amounts: under $100 approve · $105 declines · $101.31 invalid · over $100 errors

---

## What Campistry calls

| Action | Edge function | Purpose |
|--------|---------------|---------|
| Start (mint link + redirect) | `payments-hosted-link` | `save_card` / `pay_now` / `canteen` |
| Return (record result) | `payments-hosted-complete` | looks up by `key`, records |
| Autopay / auto-reload charge | `charge-due-installments` / `canteen-auto-reload` | charges `pm-<id>` or `tkn-<ref>` |
| Refund | `payments-refund` / `payments-canteen-refund` | reversal by `reference_number` |

Pending links live in `banquest_pending_links` (migration 149); a cron can call
`_admin_prune_banquest_pending_links()` to clear stale ones (>30 days).
