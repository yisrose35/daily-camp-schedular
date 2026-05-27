// =============================================================================
// get-config — Supabase Edge Function
// =============================================================================
//
// Returns API keys and configuration needed by the Campistry Go frontend.
// Keys are stored as Supabase secrets (never in source code or the database)
// and delivered only to authenticated users.
//
// REQUIRED SUPABASE SECRETS (Supabase dashboard → Edge Functions → Secrets):
//   GOOGLE_MAPS_KEY    — Google Maps / Address Validation API key
//   GEOAPIFY_KEY       — Geoapify geocoding / routing API key
//   GOOGLE_PROJECT_ID  — Google Cloud Project ID (already used by optimize-routes)
//
// REQUEST:
//   GET /functions/v1/get-config
//   Authorization: Bearer <supabase_user_access_token>
//   apikey: <supabase_anon_key>
//
// RESPONSE:
//   { googleMapsKey: string, geoapifyKey: string, googleProjectId: string }
//
// JWT verification should be ENABLED for this function (users must be logged in).
//
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const googleMapsKey  = Deno.env.get("GOOGLE_MAPS_KEY")   || "";
  const geoapifyKey    = Deno.env.get("GEOAPIFY_KEY")       || "";
  const googleProjectId = Deno.env.get("GOOGLE_PROJECT_ID") || "";
  const orsKey         = Deno.env.get("ORS_KEY")            || "";

  return new Response(
    JSON.stringify({ googleMapsKey, geoapifyKey, googleProjectId, orsKey }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  );
});
