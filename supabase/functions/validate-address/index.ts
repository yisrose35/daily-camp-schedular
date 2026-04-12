// =============================================================================
// validate-address — USPS Address Standardization via new USPS REST API
//
// Requires USPS Developer Portal credentials (free registration):
//   - USPS_CLIENT_ID (Consumer Key)
//   - USPS_CLIENT_SECRET (Consumer Secret)
//
// Request:  { street, city, state, zip }
// Response: { valid, standardized: { street, city, state, zip, zip4 }, original }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const USPS_CLIENT_ID = Deno.env.get("USPS_CLIENT_ID");
const USPS_CLIENT_SECRET = Deno.env.get("USPS_CLIENT_SECRET");
const USPS_TOKEN_URL = "https://api.usps.com/oauth2/v3/token";
const USPS_ADDRESS_URL = "https://api.usps.com/addresses/v3/address";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

let _cachedToken: string | null = null;
let _tokenExpiry = 0;

async function getUSPSToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  if (!USPS_CLIENT_ID || !USPS_CLIENT_SECRET) return null;

  try {
    const resp = await fetch(USPS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: USPS_CLIENT_ID,
        client_secret: USPS_CLIENT_SECRET,
      }).toString(),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    _cachedToken = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000; // refresh 1 min early
    return _cachedToken;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { street, city, state, zip } = await req.json();
    if (!street) {
      return new Response(JSON.stringify({ error: "street required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await getUSPSToken();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "USPS not configured. Set USPS_CLIENT_ID and USPS_CLIENT_SECRET." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call USPS Address API
    const params = new URLSearchParams({
      streetAddress: street,
      city: city || "",
      state: state || "",
      ZIPCode: zip || "",
    });

    const resp = await fetch(`${USPS_ADDRESS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[validate-address] USPS error:", resp.status, errText);
      return new Response(
        JSON.stringify({ valid: false, error: "USPS returned " + resp.status }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await resp.json();
    const addr = data.address;

    if (!addr?.streetAddress) {
      return new Response(
        JSON.stringify({ valid: false, error: "Address not found by USPS" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        standardized: {
          street: addr.streetAddress || "",
          secondary: addr.secondaryAddress || "",
          city: addr.city || "",
          state: addr.state || "",
          zip: addr.ZIPCode || "",
          zip4: addr.ZIPPlus4 || "",
        },
        original: { street, city, state, zip },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[validate-address] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
