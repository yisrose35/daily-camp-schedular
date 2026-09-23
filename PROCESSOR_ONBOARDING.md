# Connecting a Camp's Payment Processor — Onboarding Roadmap

Use `admin_connect_processor.html` (on the Desktop) for every step that says
"Run the connect." Never paste secrets into a terminal.

## Before you start (once — not per camp)

- **Supabase project ref** — from the project URL: `bzqmhcumuarrbueqttfh`
- **Service role key** — Supabase Dashboard → Settings → API → `service_role` (Secret Key)
  - If you ever get `{"success":false,"error":"unauthorized"}`, re-copy this fresh — a stale copy is the #1 cause.

## Before you start (once — per camp)

- **The camp's id** — Supabase Dashboard → Table Editor → `camps` table → find the camp's row → copy `id`

---

## Banquest

### 1. Get the camp's credentials (in the camp's own Banquest account)

Control Panel → **Source Management**:

| Field the connect tool needs | Where it comes from |
|---|---|
| `sourceKey` | The **Software / API** key's "Source Key" |
| `pin` | Shown alongside the Software/API key when you create it |
| `tokenizationKey` | The **Software / Tokenization** key's "Key" |
| `gatewayUrl` | The URL you typed when creating the API key (e.g. `https://pay.banquest.com/CampName`) |
| `tokenizationUrl` | The URL you typed when creating the Tokenization key (e.g. `https://pay.banquest.com/CampName`) |

Creating the keys:
- **Create New Key → API** → URL: `https://pay.banquest.com/<CampName>` → Save Key → note the Key + PIN → Allow Charge → Charge (no PayPal) → enable all payment methods (no PayPal)
- **Create New Key → Tokenization** → URL: `https://pay.banquest.com/<CampName>` → Save Key

### 2. Run the connect

Open `admin_connect_processor.html` → fill in project ref, service role key, camp id, pick **Banquest**, paste the 5 values above into Credentials JSON → **Connect this camp**.

### 3. Post-connect setup (every camp, no exceptions)

In the camp's own Banquest dashboard:
- Point the chargeback/dispute notification at:
  `https://bzqmhcumuarrbueqttfh.supabase.co/functions/v1/byop-dispute-webhook?processor=banquest`
  - Add `&camp=<camp id>` **only if** this is the 2nd+ camp on Banquest.
  - ⚠️ If it IS the 2nd+ camp: go back and add `&camp=<that other camp's id>` to every earlier Banquest camp's URL too — otherwise their disputes silently stop recording.
- Send one real test dispute, then check Supabase → Edge Functions → `byop-dispute-webhook` → Logs to confirm it landed.

---

## Sola / Cardknox

### 1. Get the camp's credentials (in the camp's own Sola account)

| Field the connect tool needs | Where it comes from |
|---|---|
| `apiKey` | Settings → Gateway Settings → **Create a Key → API Software** |
| `checkoutSlug` | Same screen → **Payment Site** → the Payment Site URL, just the part after `secure.cardknox.com/` |
| `webhookPin` | You invent this — any 15+ character alphanumeric string (no symbols) |

Do **not** create or use an "iFields" key — it's unused, only `API`-type keys matter here.

### 2. Run the connect

Open `admin_connect_processor.html` → fill in project ref, service role key, camp id, pick **Cardknox / Sola**, paste the 3 values above into Credentials JSON → **Connect this camp**.

### 3. Post-connect setup (every camp, no exceptions)

In the camp's own Sola dashboard:
- **Dispute webhook**: point chargeback notifications at
  `https://bzqmhcumuarrbueqttfh.supabase.co/functions/v1/byop-dispute-webhook?processor=cardknox`
  (same `&camp=` rule as Banquest above — only needed once a 2nd camp shares Cardknox)
- **Webhook Settings** → Postback URL:
  `https://bzqmhcumuarrbueqttfh.supabase.co/functions/v1/cardknox-webhook?campId=<camp id>`
  → PIN: the exact `webhookPin` you just stored
- **Redirect on success** and **Redirect on error**, same screen, both set to:
  `https://link.campistry.org/campistry_link_parent.html`
- Send one real test dispute, check the `byop-dispute-webhook` logs to confirm it landed.

---

## The one rule that applies to both

Every step above is **per camp, every time** — nothing carries over between camps, because each camp is a fully separate merchant account. The only exception is the `&camp=` parameter on dispute webhooks, which only becomes necessary once a *second* camp shares that same processor — and when it does, you must go back and add it to every earlier camp's URL on that processor too.
