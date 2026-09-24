// =============================================================================
// link-photo-checkout — Start a Stripe Checkout Session for one of the two
// Link Photos parent purchases (migration 081, multi-camper support in 082):
//   - facial_recognition: one-time fee PER CAMPER, turns on automatic photo
//     matching (get_my_camper_photos) for the rest of the season — every
//     camp photo with that child gets found and added to their stream with
//     nothing for the parent to search for. A parent with several kids can
//     turn this on for any subset of them in ONE checkout — camperNames is
//     an array, one line item per name, one link_photo_purchases row per
//     name (see the webhook's loop over meta.camperNames).
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
//             camperNames?: string[], photoId? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { url, sessionId } | { alreadyPurchased: true } | { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
// Only to read this parent's own link_photo_purchases rows by camper number
// (get_my_photo_purchases returns names only).
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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


/** A camper id sent by the page (campistry_camper_id_rpc.js adds it), or null. */
function camperIdIn(v: unknown): number | null {
  return v != null && /^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null;
}

/** A camper's name as a person reads it: without the roster's internal
 *  " #<number>" that tells two campers with one name apart. For what a parent
 *  sees; never for identifying the camper. */
function displayName(s: unknown): string {
  return String(s ?? "").replace(/\s#\d+(?:-\d+)?$/, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { campId, kind, camperNames, camperIds, photoId } = await req.json();
    // One entry per camper: the number (camperIds, position for position with
    // camperNames — the portal adds them) decides who the camper is; the name
    // is for display, and the fallback for a slot with no number.
    type Camper = { camperId: number | null; name: string };
    const campers: Camper[] = (Array.isArray(camperNames) ? camperNames as unknown[] : []).map((n, i) => ({ camperId: Array.isArray(camperIds) ? camperIdIn(camperIds[i]) : null, name: String(n ?? "") }));
    if (!campId || (kind !== "facial_recognition" && kind !== "hd_photo")) {
      return json({ error: "campId and a valid kind are required" }, 400);
    }
    if (kind === "facial_recognition" && !campers.length) {
      return json({ error: "camperNames (with camperIds) is required" }, 400);
    }
    if (kind === "hd_photo" && !photoId) return json({ error: "photoId is required" }, 400);

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const parentUserId = userData?.user?.id;
    if (!parentUserId) return json({ error: "unauthorized" }, 401);

    // Camp-wide "does this camp even run a photos program" gate (migration
    // 106) — checked before any ownership/Stripe work so a camp that never
    // uploads photos can't have parents buying folders for photos that will
    // never exist.
    const { data: programSettings } = await asUser.rpc("get_link_program_settings", { p_camp_id: campId });
    if (programSettings?.success && programSettings.photos === false) {
      return json({ error: "This camp isn't offering Link Photos right now." }, 400);
    }

    // Ownership check, per kind — never trust the client's claim. For
    // facial_recognition, EVERY name in the batch must check out; one
    // camper that isn't really this parent's fails the whole request
    // rather than silently dropping just that name.
    if (kind === "facial_recognition") {
      for (const c of campers) {
        const { data: owns } = await asUser.rpc("verify_my_camper", { p_camp_id: campId, p_camper_name: c.name, p_camper_id: c.camperId });
        if (!owns) return json({ error: `"${displayName(c.name)}" isn't linked to your account for this camp.` }, 403);
      }
    } else {
      const { data: viewable } = await asUser.rpc("get_viewable_photo_ids", { p_photo_ids: [photoId] });
      if (!Array.isArray(viewable) || !viewable.includes(photoId)) {
        return json({ error: "You can't view that photo." }, 403);
      }
    }

    // Already purchased? Drop those names/photo rather than double-charge.
    // In normal use the client only ever offers un-purchased names as
    // checkboxes, so this is a defensive backstop, not the primary path.
    const { data: existing } = await asUser.rpc("get_my_photo_purchases", { p_camp_id: campId });
    let toBuy: Camper[] = kind === "facial_recognition" ? [...campers] : [];
    if (kind === "facial_recognition") {
      // get_my_photo_purchases lists purchases by NAME only, so a camper with
      // a number is checked against the purchase rows' person_id instead
      // (read with the service role, only this parent's own rows). A row with
      // a number matches by its number alone; the name is compared only for
      // a camper or a row that has no number.
      const boughtIds = new Set<number>();
      const boughtUnnumbered = new Set<string>();
      let rowsRead = false;
      if (SUPABASE_SERVICE_KEY) {
        const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { data: rows, error: rowsErr } = await service.from("link_photo_purchases")
          .select("camper_name, person_id")
          .eq("camp_id", campId).eq("parent_user_id", parentUserId).eq("kind", "facial_recognition");
        if (!rowsErr && Array.isArray(rows)) {
          rowsRead = true;
          for (const r of rows as Array<{ camper_name: string | null; person_id: number | string | null }>) {
            const rid = camperIdIn(r.person_id);
            if (rid != null) boughtIds.add(rid);
            else if (r.person_id == null && r.camper_name) boughtUnnumbered.add(String(r.camper_name));   // a row with no number: by its name
          }
        }
      }
      const boughtByName = new Set<string>((existing?.success && existing.facialRecognition) || []);
      toBuy = toBuy.filter((c) => {
        if (!rowsRead) return !boughtByName.has(c.name);   // rows unreadable: by name, as before
        return c.camperId != null ? !boughtIds.has(c.camperId) : !(boughtUnnumbered.has(c.name) || boughtByName.has(c.name));   // no number: by name, as before
      });
      if (!toBuy.length) return json({ alreadyPurchased: true });
    } else if (existing?.success && (existing.hdPhotoIds || []).includes(photoId)) {
      return json({ alreadyPurchased: true });
    }

    const origin = req.headers.get("origin") || "";
    const success = `${origin}/campistry_pay_thanks.html?status=success&type=link-photo`;
    const cancel = `${origin}/campistry_pay_thanks.html?status=cancelled&type=link-photo`;

    const meta: Record<string, string> = {
      campId: String(campId),
      parentUserId: String(parentUserId),
      kind: String(kind),
      // Position for position: the webhook records each purchase by its number.
      camperIds: kind === "facial_recognition" ? JSON.stringify(toBuy.map((c) => c.camperId)) : "", camperNames: kind === "facial_recognition" ? JSON.stringify(toBuy.map((c) => c.name)) : "",
      photoId: String(photoId || ""),
      source: "campistry-link-photo-purchase",
    };

    const params: Record<string, string> = {
      "mode": "payment",
      "success_url": success,
      "cancel_url": cancel,
    };
    let totalCents: number;
    let description: string;
    if (kind === "facial_recognition") {
      toBuy.forEach((c, i) => {
        params[`line_items[${i}][quantity]`] = "1";
        params[`line_items[${i}][price_data][currency]`] = "usd";
        params[`line_items[${i}][price_data][unit_amount]`] = String(FACIAL_RECOGNITION_FEE_CENTS);
        params[`line_items[${i}][price_data][product_data][name]`] = `Automatic photo matching — ${displayName(c.name)}`;
      });
      totalCents = FACIAL_RECOGNITION_FEE_CENTS * toBuy.length;
      description = `Automatic photo matching for ${toBuy.map((c) => displayName(c.name)).join(", ")}`;
    } else {
      params["line_items[0][quantity]"] = "1";
      params["line_items[0][price_data][currency]"] = "usd";
      params["line_items[0][price_data][unit_amount]"] = String(HD_PHOTO_FEE_CENTS);
      params["line_items[0][price_data][product_data][name]"] = "Link Photos — HD download";
      totalCents = HD_PHOTO_FEE_CENTS;
      description = "Link Photos — HD download";
    }
    params["payment_intent_data[description]"] = description;
    Object.entries(meta).forEach(([k, v]) => {
      params[`metadata[${k}]`] = v;
      params[`payment_intent_data[metadata][${k}]`] = v;
    });

    const session = await stripePost("/checkout/sessions", params);
    if (session.error) throw new Error(session.error.message);

    console.log(`[link-photo-checkout] Session ${session.id}: ${kind} for camp ${campId} — $${totalCents / 100}`);

    return json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[link-photo-checkout] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
