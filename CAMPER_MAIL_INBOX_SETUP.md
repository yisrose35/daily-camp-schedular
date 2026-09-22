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
        ↓  verify signature → which camp (token) → which child
link_camper_mail table   (source = 'email')
        ↓
  camper code in subject/body              → assigned to that child, from ANY address
  known parent, one child                  → auto-assigned
  known parent, several children           → the name in the subject/first line decides
  can't be pinned to a child               → stored '(unassigned)', office assigns in one click
```

**Nothing is dropped by default** — a letter that can't be matched is stored as
`(unassigned)` for the office to place. A camp that gets flooded with junk can
turn on the *Known parents only* gate, after which mail from an unknown address
with no valid code is dropped instead.

Emailed letters land in the same table (migration 015) as Link letters, so they
appear together in Live with no separate screen. `source = 'email'` only drives
the "✉ Email" tag and the **Assign** button.

---

## How a letter is matched to a camper

The one hard problem is *which child is this for*. Three signals, tried in order:

1. **The camper code** — `<camp number>-<camper id>`, e.g. `1234-57`, the parent
   types into the subject or first line. This is the reliable one: it works **no
   matter which email address the letter comes from** (a work inbox, a
   grandparent, a shared family account). The camp number must match this camp's
   own before the second half is read as a camper, so a stray `718-555` or a
   date like `2026-09` can't misfile anything. It's the **same reference format
   as the deposit memo** (migration 149) and reuses the camp's deposit number
   when it has one, so a family's code is identical in a bank memo and an email.
   Parents see their children's codes in **Campistry Link → Camper Mail**.
2. **The sender's email** matched against the parent emails on the camp's invites
   (`link_parent_invites`, migration 008) — for parents who email from their
   registered address and type no code.
3. **The camper's name** in the subject/first line, used only to pick between the
   children of a parent who has more than one at camp.

A letter none of these can pin is stored as `(unassigned)` — never dropped. It
shows in Live under the **"Unassigned — check placement"** group with an
**Assign** button that pins it to a camper (and fills in division/grade/bunk) in
one click. (Turn on *Known parents only* to instead drop unknown-sender, no-code
mail — see below.)

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

- **Tighten the spam gate:** `set_camper_mail_inbox_settings` (owner/admin),
  params `p_enabled`, `p_known_parents_only`, `p_rotate_token`. `p_known_parents_only`
  is **off by default** (unmatched mail is kept as `(unassigned)`); set it true
  only if a camp gets flooded, after which unknown-sender no-code mail is dropped.
- **Rotate the address** (if it ever leaks to a spammer): call with
  `p_rotate_token => true`. No DNS change — only the address a camp is *told*
  changes, so re-share it.

---

## Security

Every delivery is authenticated before anything is stored:

1. **Svix signature** over the raw body — proves Resend sent it. The only check
   that returns non-200; an unsigned request is not a delivery worth retrying.
2. **Routing token** in the To: address — proves which camp.

The camper code and the sender-email match then decide *which child*; the camp
number guards the code so a stray digit-pair can't misfile a letter. Unlike the
deposit token, the camper-mail token and the codes are **shared with parents on
purpose** — they are the senders, and a letter carries no money, so the failure
of a leaked address is a junk row a human deletes, not a wrong payment. The token
only says which camp, and rotating it costs nothing but a re-share. The
service-role RPCs (`_camper_mail_camp_for_token`, `_camper_mail_candidates`,
`_camper_mail_by_camper_number`, `_camper_mail_record`) are revoked from every
client role — only the edge function's service role can reach them.
