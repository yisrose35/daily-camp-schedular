// =============================================================================
// read-receipt — pull the details out of a receipt, invoice or payment screenshot
//
// Logging an expense meant reading a crumpled receipt and typing the date,
// vendor, amount and category by hand, one line at a time. This reads the
// document instead: the office uploads a photo or a PDF, Claude extracts the
// transactions, and the office reviews them on one screen before saving.
//
// It EXTRACTS, it does not decide. Everything it returns lands in a review
// screen the office confirms — nothing is written to the ledger from here, and
// each row carries a confidence so a smudged total is visibly a guess rather
// than quietly wrong.
//
// REQUIRED SUPABASE SECRET:
//   ANTHROPIC_API_KEY — from console.anthropic.com
//
// REQUEST:
//   POST /functions/v1/read-receipt
//   Authorization: Bearer <supabase user access token>
//   { file: { data: "<base64, no prefix>", mediaType: "image/jpeg" | "application/pdf" },
//     knownCategories?: string[],   // the camp's existing expense categories
//     currencyHint?: string }
//
// RESPONSE:
//   { documentType, currency, transactions: [{ date, vendor, description,
//     amount, category, confidence }], notes, usage }
//
// JWT verification should be ENABLED — each call spends tokens, so it must not
// be reachable by anyone holding only the anon key.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.68.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Anything larger is a photo nobody downscaled. The request cap is 32MB, but a
// 10MB receipt costs tokens without reading any better than a 2MB one.
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MEDIA = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf",
];

// Fallback categories for a camp that has not logged an expense yet.
const DEFAULT_CATEGORIES = [
  "Food & Kitchen", "Program & Activities", "Facilities & Maintenance",
  "Transportation", "Office & Admin", "Insurance", "Marketing",
  "Medical & Health", "Utilities", "Equipment", "Miscellaneous",
];

const SYSTEM = `You read camp expense documents and extract the transactions on them.

You are the first step of a review screen: everything you return is checked by a
person before it reaches the ledger. Extract what the document says. Do not
invent a value to fill a field, and do not round or tidy an amount.

Rules:
- One entry per distinct transaction. A receipt with many line items from a
  single purchase is ONE transaction at the total paid, not one per line. A bank
  statement or a page of several receipts is several transactions.
- amount is what the camp actually paid: the final total, after tax, discounts
  and tips. Never the subtotal.
- date is the transaction date in YYYY-MM-DD. If the document shows only a
  partial date, use what is shown and say so in notes. If there is no date at
  all, use an empty string.
- vendor is the business paid. Prefer the trading name over a legal entity name
  or a payment processor's descriptor.
- category must be chosen from the provided list. Pick the closest fit;
  "Miscellaneous" when nothing fits.
- confidence is "high" when the field was printed clearly, "medium" when you
  inferred it, "low" when the document is unclear, damaged, or cut off.
- A refund or credit is a negative amount.
- notes is for what the reviewer needs to know: an unreadable total, a currency
  that is not the camp's, a second page that appears to be missing, a date you
  had to infer. Leave it empty when the document is clean.

If the image is not a financial document at all, return an empty transactions
array and say what it is in notes.`;

function schemaFor(categories: string[]) {
  return {
    type: "object",
    properties: {
      documentType: {
        type: "string",
        enum: ["receipt", "invoice", "zelle_confirmation", "bank_statement",
               "payment_screenshot", "not_a_financial_document", "other"],
        description: "What kind of document this is.",
      },
      currency: {
        type: "string",
        description: "ISO 4217 code of the amounts, e.g. USD. Empty if not shown.",
      },
      transactions: {
        type: "array",
        description: "One entry per distinct transaction. Empty if none found.",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD, or empty if absent." },
            vendor: { type: "string", description: "The business paid." },
            description: { type: "string", description: "Short summary of what was bought." },
            amount: { type: "number", description: "Total paid. Negative for a refund." },
            category: { type: "string", enum: categories },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["date", "vendor", "description", "amount", "category", "confidence"],
          additionalProperties: false,
        },
      },
      notes: { type: "string", description: "What the reviewer should check. Empty if clean." },
    },
    required: ["documentType", "currency", "transactions", "notes"],
    additionalProperties: false,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "Receipt reading is not configured. Set the ANTHROPIC_API_KEY secret." }, 500);
  }

  // Each call spends tokens, so it must be a signed-in user of this camp — not
  // anyone who scraped the anon key out of the page.
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "Not signed in" }, 401);
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return json({ error: "Not signed in" }, 401);
  } catch (_) {
    return json({ error: "Not signed in" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch (_) { return json({ error: "Invalid JSON body" }, 400); }

  const file = body?.file;
  if (!file?.data || !file?.mediaType) {
    return json({ error: "file.data (base64) and file.mediaType are required" }, 400);
  }
  if (!ALLOWED_MEDIA.includes(file.mediaType)) {
    return json({ error: `Unsupported file type ${file.mediaType}. Upload a JPG, PNG, WEBP, GIF or PDF.` }, 400);
  }
  // base64 is 4 chars per 3 bytes; measure the decoded size, not the string.
  const approxBytes = Math.floor(String(file.data).length * 0.75);
  if (approxBytes > MAX_BYTES) {
    return json({ error: "That file is over 10MB. Take the photo again at a smaller size." }, 413);
  }

  const categories: string[] = Array.isArray(body?.knownCategories) && body.knownCategories.length
    // The camp's own categories come first so the model reuses them rather than
    // inventing a parallel set that splits their reporting in two.
    ? Array.from(new Set([...body.knownCategories.map(String), "Miscellaneous"]))
    : DEFAULT_CATEGORIES;

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const isPdf = file.mediaType === "application/pdf";
  const docBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }
    : { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data } };

  const hint = body?.currencyHint ? `\n\nThe camp's currency is ${String(body.currencyHint)}.` : "";

  try {
    const response: any = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      // Adaptive thinking earns its keep here: receipts arrive rotated, folded,
      // thermal-faded, and with the total in a different place every time.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: schemaFor(categories) },
      },
      // A declined request is re-run on another model server-side rather than
      // handing the office an error it can do nothing about.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          docBlock,
          { type: "text", text: `Extract every transaction on this document.${hint}` },
        ],
      }],
    });

    // A refusal is a successful HTTP 200 with no usable content — read
    // stop_reason before touching content, or this throws on an empty array.
    if (response.stop_reason === "refusal") {
      return json({
        error: "That document couldn't be read automatically. Enter it by hand.",
        refused: true,
        category: response.stop_details?.category ?? null,
      }, 422);
    }

    const textBlock = (response.content || []).find((b: any) => b.type === "text");
    if (!textBlock?.text) {
      return json({ error: "No details could be read from that document." }, 422);
    }

    let parsed: any;
    try { parsed = JSON.parse(textBlock.text); }
    catch (_) { return json({ error: "The document was read but the result was unusable." }, 502); }

    const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
    return json({
      documentType: parsed.documentType || "other",
      currency: parsed.currency || "",
      notes: parsed.notes || "",
      transactions,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    });
  } catch (err) {
    console.error("[read-receipt]", err);
    const status = (err as any)?.status;
    if (status === 429) return json({ error: "Too many receipts at once — try again in a moment." }, 429);
    if (status === 401) return json({ error: "The Anthropic API key is not valid." }, 500);
    return json({ error: (err as any)?.message || "Could not read that document." }, 500);
  }
});
