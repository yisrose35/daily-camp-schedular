# Campistry receipt reading — setup

Upload a receipt, invoice, Zelle confirmation or bank statement and Campistry
fills in the date, vendor, amount and category for you. The office reviews
everything on one screen before it reaches the ledger.

**Me → Analytics & Finance → Expenses → 📄 Upload a receipt**

## What it does

1. The office uploads a photo or PDF (JPG, PNG, WEBP, GIF, PDF — up to 10MB).
2. The `read-receipt` edge function sends it to Claude, which extracts every
   transaction on the document.
3. A review screen lists what was read. Every field is editable, each row can be
   excluded, and each carries the confidence it was read with.
4. Saving writes the ticked rows into the expense ledger.

**Nothing is written without the office confirming it.** The extraction is a
first draft, not an authority — a smudged total comes back marked *low
confidence* rather than quietly wrong.

Categories are drawn from the ones the camp already uses, so a receipt doesn't
invent a parallel set that splits the reporting in two.

## One-time setup

### 1. Get an Anthropic API key

[console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key.
Note this is billed by Anthropic, separately from Campistry and Stripe.

### 2. Set the secret

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 3. Deploy the function

```bash
supabase functions deploy read-receipt
```

### 4. Leave JWT verification ON

Every call spends tokens, so the function must not be reachable by anyone
holding only the anon key. It verifies the caller's Supabase session and rejects
anything else with a 401. `callEdgeFunction` sends the signed-in user's access
token, so this needs no configuration — just don't disable JWT verification for
this function.

## Cost

Billed per token by Anthropic. A single receipt photo is a few thousand input
tokens plus a short JSON response — cents, not dollars. A camp logging a few
hundred receipts a season should expect a small monthly bill. Watch it in the
Anthropic console; if it matters, the 10MB cap and the review-before-save step
both keep the call count to one per document.

## Notes / follow-ups

- **Photograph the whole receipt.** A total cut off at the edge comes back as
  *low confidence*, or missing with a note saying a page looks absent.
- **A refund reads as a negative amount**, so it nets correctly against the
  category it was originally charged to.
- **Multi-transaction documents work.** A bank statement or a page of several
  receipts returns one row per transaction; a single purchase with many line
  items returns one row at the total paid, not one row per line.
- **A non-financial image is handled, not guessed at** — the review screen says
  what the file appears to be and offers manual entry instead.
- Saved expenses keep `source: 'receipt'`, the file name, and the read
  confidence, so a figure queried months later can be traced back to the
  document it came from.
