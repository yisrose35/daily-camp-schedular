# Camper Mail by email — parents send a letter from Gmail

Families can already write a letter inside Campistry Link and the office prints
it from **Live → Camper Mail**. This adds the other way in: a parent sends a
**plain email from Gmail (or any inbox)** to the camp's own address, and it
drops into the *same* Camper Mail queue, matched to the right camper, ready for
**Print all** — which now prints the whole batch pre-sorted by division → grade
→ bunk so nobody has to sort the stack by hand.

It reuses the exact inbound-email plumbing the deposit inbox already runs on
(Resend inbound + a Supabase edge function), so most of the one-time setup is
**already done** if deposits are live.

---

## What arrives where

```
Parent emails a letter from Gmail
        ↓
letters+<token>@<your inbound domain>        ← Resend receives it
        ↓  email.received webhook
camper-mail-inbox  (Supabase edge function)
        ↓  verify signature → which camp (token) → which child (sender email)
link_camper_mail table   (source = 'email')
        ↓
  sender is a known parent, one child      → stored, auto-assigned
  sender known, several children           → the name in the subject/first line decides
  can't be pinned to a child               → stored '(unassigned)', office assigns in one click
  sender is NOT a known parent             → dropped (anti-spam gate)
```

Emailed letters land in the same table (migration 015) as Link letters, so they
appear together in Live with no separate screen. `source = 'email'` only drives
the "✉ Email" tag and the **Assign** button.

---

## How a letter is matched to a camper

The one hard problem is *which child is this for*. Two signals do it, both from
data the camp already has (`link_parent_invites`, migration 008):

1. **The sender's email** is matched against the parent emails on the camp's
   invites. This is also the **anti-spam gate** — with *Known parents only* on
   (the default), mail from an address the camp doesn't recognise is dropped
   without ever creating a row. A public address otherwise fills the print queue
   with junk.
2. **The camper's name** in the subject or first line, used only when one parent
   has more than one child at camp. One child → auto-assigned. Several, and the
   name decides; ambiguous or missing → stored `(unassigned)` for the office.

Nothing is ever silently misfiled: an unmatched letter shows up in Live under
the **"Unassigned — check placement"** group with an **Assign** button that
pins it to a camper (and fills in their division/grade/bunk) in one click.

---

## One-time setup (Supabase Dashboard — no CLI)

### 1. Apply the migration

Supabase Dashboard → **SQL Editor** → paste the entire contents of
`migrations/204_camper_mail_inbox.sql` and run it. It is idempotent — safe to
re-run. It adds `camp_camper_mail_settings`, two columns on `link_camper_mail`
(`source`, `inbound_fingerprint`), and the RPCs the app and the function use.

### 2. Deploy the edge function

Supabase Dashboard → **Edge Functions** → **Deploy a new function**.

- Name: **`camper-mail-inbox`**
- Paste the entire contents of `supabase/functions/camper-mail-inbox/index.ts`.
- **Verify JWT: OFF** — Resend is not a Supabase caller; the function
  authenticates every request itself with the Svix signature.

> The file is deliberately one self-contained file with no local imports,
> because the Dashboard flattens a function to `source/index.ts` and a relative
> import would fail to resolve at deploy time.

### 3. Inbound email in Resend

**If deposits are already live, you already have this** — the same inbound
domain (`inbound.campistry.org`) receives camper mail too. Skip to step 4.

Otherwise: Resend Dashboard → **Inbound** → add your domain and the **MX record
Resend shows you** on the `inbound` subdomain at your DNS provider. Resend won't
accept mail until it verifies. (A Resend *managed* address — `<id>.resend.app`,
no DNS — works for a pilot; the function accepts both the `letters+<token>` and
bare-token address forms.)

### 4. Register the webhook (this is where the signing secret comes from)

Resend Dashboard → **Webhooks** → **Add endpoint**:

- URL: `https://<your-project-ref>.supabase.co/functions/v1/camper-mail-inbox`
- Event: **`email.received`**

When you save it, Resend shows a **signing secret starting `whsec_`**. This is a
**new, separate secret from the deposit webhook's** — copy it for step 5.

> **Why a second webhook and secret.** Resend signs each endpoint with its own
> secret, and the inbound domain delivers every message to *both* endpoints.
> `deposits+…` mail that reaches this function fails the token lookup and is
> skipped; `letters+…` mail that reaches deposit-inbox does the same there — the
> two never double-process. But each function must verify its own copy, so each
> needs its own secret under its own env var.

### 5. Set the secrets

Supabase Dashboard → **Edge Functions → Secrets**:

| Secret | Value | Where it comes from |
| --- | --- | --- |
| `CAMPER_MAIL_WEBHOOK_SECRET` | the `whsec_…` from **step 4** | the camper-mail webhook endpoint (NOT the deposit one) |
| `RESEND_API_KEY` | your existing Resend key | already set for `send-invite-email` / `deposit-inbox` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 6. (If not already done for deposits) point the app at the inbound domain

The three apps already default to `inbound.campistry.org`. If your inbound
domain differs, set `window.CAMPISTRY_INBOUND_DOMAIN` to it near the top of
`campistry_live.html`, `campistry_link_parent.html`, and `campistry_me.html`
(one line each) so the address shown to staff and parents matches what Resend
actually receives on.

### 7. Confirm with one live delivery

Send a real email to `letters+<token>@<inbound domain>` (get the exact address
from **Live → Camper Mail**, "Families can email letters here"). Check the
function logs show `letter stored`, and that it appears in the Camper Mail list.
Resend's `email.received` field names aren't fully documented; the function
already accepts the common spellings and fetches the body when the payload
carries metadata only, but a first live delivery is the way to be sure.

---

## Per-camp configuration

A camp needs **nothing** beyond the platform setup above. On the first visit to
**Live → Camper Mail** by an owner/admin, a routing token is minted and the
address appears at the top of the page with a **Copy** button. Parents see the
same address in **Campistry Link → Camper Mail → "Prefer email?"**.

- **Turn it off / on, or loosen the spam gate:** `set_camper_mail_inbox_settings`
  (owner/admin), params `p_enabled`, `p_known_parents_only`, `p_rotate_token`.
  Turn *Known parents only* off briefly when testing if you want to see anything
  reach the address at all; turn it back on before real use.
- **Rotate the address** (if it ever leaks to a spammer): call with
  `p_rotate_token => true`. No DNS change — only the address a camp is *told*
  changes, so re-share it.

---

## Security

Every request is authenticated by three independent checks, all required:

1. **Svix signature** over the raw body — proves Resend sent it. The only check
   that returns non-200; an unsigned request is not a delivery worth retrying.
2. **Routing token** in the To: address — proves which camp.
3. **Sender matched to a known parent** — the anti-spam gate and what pins the
   letter to the right child.

Unlike the deposit token, the camper-mail token is **shared with parents on
purpose** — they are the senders. Secrecy isn't the defence; the known-parents
gate is. The token only says which camp, and rotating it costs nothing but a
re-share. The service-role RPCs (`_camper_mail_camp_for_token`,
`_camper_mail_candidates`, `_camper_mail_record`) are revoked from every client
role — only the edge function's service role can reach them.
