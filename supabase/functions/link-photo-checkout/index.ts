// =============================================================================
// link-photo-checkout — Start a Stripe Checkout Session for one of the two
// Link Photos parent purchases (migration 081):
//   - facial_recognition: one-time fee PER CAMPER, unlocks the existing
//     AI-filtered "just my kid" view (get_my_camper_photos) for the season.
//   - hd_photo: flat fee PER PHOTO, unlocks a full-resolution download for
//     one specific photo (see get-photo-urls' resolution:'original' mode).
//
// A NEW dedicated function rather than another stripe-checkout `source`
// branch, deliberately: stripe-checkout is anon-key-only with no session
// auth (documented residual gap in its own header) and lets the CALLER
// pick the charge amount — both wrong fits here. This function requires
// the caller's real parent session (to know whose purchase this is and to
// run ownership checks) and charges a server-side FIXED price the client
// can never influence.
//
// Destination: Campistry's OWN platform Stripe account — deliberately NOT
// a Connect destination charge to the camp. Unlike tuition/canteen/tips,
// this is Campistry's own product (the AI matching + storage/bandwidth
// behind it), so the money settles on the platform account and never
// transfers out to the camp. This also means a camp does NOT need Stripe
// Connect set up at all for parents to buy either of these — there is no
// "camp hasn't set up payments" gate here, unlike canteen deposits.
//
// Request:  { campId, kind: 'facial_recognition' | 'hd_photo',
//             camperName?, photoId? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { url, sessionId } | { alreadyPurchased: true } | { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// Server-side fixed prices — the client can never influence either amount.
const FACIAL_RECOGNITION_FEE_CENTS = 895; // $8.95, one-time per camper for the season
const HD_PHOTO_FEE_CENTS = 400;           // $4 placeholder, flat per photo

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function stripePost(endpoint: string, body: Record<string, string>) {
  const resp = await fetch(`${STRIPE_API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { campId, kind, camperName, photoId } = await req.json();
    if (!campId || (kind !== "facial_recognition" && kind !== "hd_photo")) {
      return json({ error: "campId and a valid kind are required" }, 400);
    }
    if (kind === "facial_recognition" && !camperName) return json({ error: "camperName is required" }, 400);
    if (kind === "hd_photo" && !photoId) return json({ error: "photoId is required" }, 400);

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const parentUserId = userData?.user?.id;
    if (!parentUserId) return json({ error: "unauthorized" }, 401);

    // Ownership check, per kind — never trust the client's claim.
    if (kind === "facial_recognition") {
      const { data: owns } = await asUser.rpc("verify_my_camper", { p_camp_id: campId, p_camper_name: camperName });
      if (!owns) return json({ error: "That camper isn't linked to your account for this camp." }, 403);
    } else {
      const { data: viewable } = await asUser.rpc("get_viewable_photo_ids", { p_photo_ids: [photoId] });
      if (!Array.isArray(viewable) || !viewable.includes(photoId)) {
        return json({ error: "You can't view that photo." }, 403);
      }
    }

    // Already purchased? Short-circuit rather than double-charge — no
    // Stripe call at all in that case.
    const { data: existing } = await asUser.rpc("get_my_photo_purchases", { p_camp_id: campId });
    if (existing?.success) {
      if (kind === "facial_recognition" && (existing.facialRecognition || []).includes(camperName)) {
        return json({ alreadyPurchased: true });
      }
      if (kind === "hd_photo" && (existing.hdPhotoIds || []).includes(photoId)) {
        return json({ alreadyPurchased: true });
      }
    }

    const cents = kind === "facial_recognition" ? FACIAL_RECOGNITION_FEE_CENTS : HD_PHOTO_FEE_CENTS;
    const label = kind === "facial_recognition"
      ? `Link Photos — dedicated folder for ${camperName}`
      : "Link Photos — HD download";
    const origin = req.headers.get("origin") || "";
    const success = `${origin}/campistry_pay_thanks.html?status=success&type=link-photo`;
    const cancel = `${origin}/campistry_pay_thanks.html?status=cancelled&type=link-photo`;

    const meta: Record<string, string> = {
      campId: String(campId),
      parentUserId: String(parentUserId),
      kind: String(kind),
      camperName: String(camperName || ""),
      photoId: String(photoId || ""),
      source: "campistry-link-photo-purchase",
    };

    const params: Record<string, string> = {
      "mode": "payment",
      "success_url": success,
      "cancel_url": cancel,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(cents),
      "line_items[0][price_data][product_data][name]": label,
      "payment_intent_data[description]": label,
    };
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[link-photo-checkout] Session ${session.id}: ${kind} for camp ${campId} — $${cents / 100}`);

    return json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[link-photo-checkout] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
