// =============================================================================
// cardknox-checkout-start — BYOP: mints a link to Sola's own hosted checkout
// page (PaymentSITE/"Sola Checkout", confirmed live at
// https://secure.cardknox.com/<slug>) for a specific tuition payment or
// canteen deposit, instead of embedding Cardknox's iFields widget on
// campistry_card_setup.html.
//
// Why this exists (over the iFields flow payments-checkout/
// payments-canteen-checkout already handle): live testing this session
// found the embedded card-entry widget worked once fixed, but the office
// wanted the real Sola-hosted page instead — confirmed to genuinely support
// per-transaction amounts via ?xAmount= and a real webhook notification
// (docs.solapayments.com/products/webhooks). Sola's hosted page has no way
// to carry a JSON metadata blob the way a Stripe Checkout Session can, so
// this generates our own reference, stores a pending "intent" row keyed by
// it (migration 134), and passes that reference as xInvoice — the one field
// Sola's own docs recommend for exactly this "correlate a request to its
// later result" role. cardknox-webhook (the actual money-crediting
// function) resolves back to this row once Sola calls it back.
//
// No session (mirrors payments-checkout/payments-canteen-checkout's own
// reasoning — a parent tapping Pay Now/Add Funds in Link has no session
// worth trusting more than an ownership check; an office-generated pay link
// has none at all). Same campOwnsFamily/campOwnsCamper safety net as those
// two functions — a money-moving action never proceeds off a client-supplied
// campId/familyKey/camperName alone.
//
// Request:  { campId, kind: 'tuition_charge'|'canteen_deposit'|'card_save'|
//              'canteen_autoreload_setup', familyKey?, familyName?,
//              camperName?, amount?, description? }
//   - card_save / canteen_autoreload_setup carry no amount (Sola's cc:save,
//     migration 136) — card_save saves a card for a FAMILY (tuition/
//     autopay), canteen_autoreload_setup for a CAMPER (canteen auto-reload).
// Response: { success: true, url } or { success: false, error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Copied verbatim from payments-checkout.ts / payments-canteen-checkout.ts —
// same reasoning, same shape, kept duplicated per this project's existing
// convention for small per-function safety checks rather than a shared
// import chain that would need its own _shared file.
async function campOwnsFamily(service: ReturnType<typeof createClient>, campId: string, familyKey: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle();
  const families = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).families : null;
  return !!(families && typeof families === "object" && Object.prototype.hasOwnProperty.call(families, familyKey));
}

async function campOwnsCamper(service: ReturnType<typeof createClient>, campId: string, camperName: string): Promise<boolean> {
  const { data } = await service.from("camp_state_kv").select("value")
    .eq("camp_id", campId).eq("key", "app1").maybeSingle();
  const roster = data?.value && typeof data.value === "object" ? (data.value as Record<string, any>).camperRoster : null;
  return !!(roster && typeof roster === "object" && Object.prototype.hasOwnProperty.call(roster, camperName));
}

async function canteenProgramEnabled(service: ReturnType<typeof createClient>, campId: string): Promise<boolean> {
  const { data } = await service.from("camp_link_program_settings").select("canteen_enabled").eq("camp_id", campId).maybeSingle();
  return !data || data.canteen_enabled !== false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { campId, kind, familyKey, familyName, camperName, amount, description } = await req.json();
    // card_save and canteen_autoreload_setup carry no amount — both are
    // Sola's cc:save, which tokenizes a card without charging (migration
    // 136): card_save is keyed to a FAMILY (tuition/autopay),
    // canteen_autoreload_setup to a CAMPER (canteen auto-reload's card lives
    // on campistrySnacks.accounts[camperName].autoReload, not a family
    // record). Everything else must carry a real amount.
    const isCardSave = kind === "card_save" || kind === "canteen_autoreload_setup";
    if (!campId || !kind || (!amount && !isCardSave)) {
      return json({ success: false, error: "campId, kind, and amount are required" }, 400);
    }
    const VALID_KINDS = ["tuition_charge", "canteen_deposit", "card_save", "canteen_autoreload_setup"];
    if (!VALID_KINDS.includes(kind)) {
      return json({ success: false, error: "kind must be one of: " + VALID_KINDS.join(", ") }, 400);
    }
    const amountCents = isCardSave ? 0 : Math.round(Number(amount) * 100);
    if (!isCardSave && (!Number.isFinite(amountCents) || amountCents < 50)) {
      return json({ success: false, error: "Enter an amount of at least $0.50" }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (kind === "tuition_charge" || kind === "card_save") {
      if (!familyKey) return json({ success: false, error: "familyKey is required" }, 400);
      if (!(await campOwnsFamily(service, campId, familyKey))) {
        return json({ success: false, error: "Family not found for this camp" }, 400);
      }
    } else {
      // canteen_deposit or canteen_autoreload_setup — both per-camper.
      if (!camperName) return json({ success: false, error: "camperName is required" }, 400);
      if (!(await canteenProgramEnabled(service, campId))) {
        return json({ success: false, error: "Canteen isn't available for this camp." }, 400);
      }
      if (!(await campOwnsCamper(service, campId, camperName))) {
        return json({ success: false, error: "Camper not found for this camp" }, 400);
      }
    }

    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    if (camp?.payment_processor_key !== "cardknox") {
      return json({ success: false, error: "This camp isn't connected to a processor with hosted checkout support." }, 400);
    }

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) {
      return json({ success: false, error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);
    }
    const checkoutSlug = credResult.credentials?.checkoutSlug;
    if (!checkoutSlug) {
      // Same rollout shape as migration 133's ifieldsKey gap — a camp
      // connected before this feature just doesn't have this field yet and
      // needs one more admin-connect-processor run with it added.
      return json({ success: false, error: "Online checkout isn't finished setting up for this camp yet — contact the office." }, 400);
    }

    // Own reference, not Cardknox's — xInvoice is the one field Sola's
    // hosted checkout carries through to its webhook, so this is the only
    // way to tie an async result back to "what was this for."
    const reference = "ckcs_" + crypto.randomUUID().replace(/-/g, "");

    const { data: intentResult, error: intentErr } = await service.rpc("create_cardknox_checkout_intent", {
      p_camp_id: campId,
      p_reference: reference,
      p_kind: kind,
      p_family_key: familyKey || null,
      p_family_name: familyName || null,
      p_camper_name: camperName || null,
      p_amount_cents: amountCents,
      p_description: description || (kind === "card_save" ? ("Save a card — " + (familyName || familyKey))
        : kind === "canteen_autoreload_setup" ? ("Save a card for auto-reload — " + camperName)
        : kind === "canteen_deposit" ? ("Canteen funds — " + camperName) : "Camp payment"),
    });
    if (intentErr || !intentResult?.success) {
      return json({ success: false, error: intentResult?.error || "Could not start checkout — try again." }, 500);
    }

    // xCommand=cc:save is what turns Sola's hosted page into a tokenize-only
    // form with no amount — taken from the link Sola's own Send Payment
    // Request screen generates with TRANSACTION TYPE set to "save", not
    // guessed. Sending xAmount alongside it would put a charge back on the
    // page, so the two are deliberately exclusive.
    const url = "https://secure.cardknox.com/" + encodeURIComponent(checkoutSlug) +
      (isCardSave
        ? "?xCommand=" + encodeURIComponent("cc:save")
        : "?xAmount=" + encodeURIComponent((amountCents / 100).toFixed(2))) +
      "&xInvoice=" + encodeURIComponent(reference);

    console.log(`[cardknox-checkout-start] ${kind} intent ${reference}: ${isCardSave ? "card save" : "$" + amount}, camp ${campId}`);
    return json({ success: true, url, reference });
  } catch (err) {
    console.error("[cardknox-checkout-start] Error:", (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});
