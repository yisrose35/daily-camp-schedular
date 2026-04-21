// =============================================================================
// optimize-routes — Supabase Edge Function
// =============================================================================
//
// Proxies requests to the Google Route Optimization API (GMPRO) using a
// Google service account for OAuth2 authentication.
//
// WHY THIS EXISTS:
//   The GMPRO API is a Google Cloud API. It does not accept simple API keys
//   from browser requests — it requires an OAuth2 Bearer token signed by a
//   service account. This edge function runs server-side in Deno, holds the
//   service account JSON as a secret, mints a short-lived Bearer token, and
//   forwards the routing request to Google.
//
// REQUIRED SUPABASE SECRET:
//   GOOGLE_SERVICE_ACCOUNT — the full contents of the service account JSON
//   key file downloaded from Google Cloud Console → IAM → Service Accounts.
//   Set it with:
//     supabase secrets set GOOGLE_SERVICE_ACCOUNT="$(cat service-account.json)"
//
// REQUEST:
//   POST /functions/v1/optimize-routes
//   Authorization: Bearer <supabase_user_access_token>
//   Content-Type: application/json
//   Body: a valid GMPRO OptimizeTours request body (passed through as-is)
//
// RESPONSE:
//   The raw GMPRO OptimizeTours response, with the same HTTP status code.
//   On server error: { "error": "message" } with status 500.
//
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Service account type ────────────────────────────────────────────────────

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

// ─── Base64url (URL-safe base64, no padding) ─────────────────────────────────
// JWT requires base64url encoding, not standard base64.

function base64url(input: string | Uint8Array): string {
  let b64: string;
  if (typeof input === "string") {
    // Encode UTF-8 string → bytes → base64
    const bytes = new TextEncoder().encode(input);
    b64 = btoa(String.fromCharCode(...bytes));
  } else {
    b64 = btoa(String.fromCharCode(...input));
  }
  // Convert to URL-safe and strip padding
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── Mint a Google OAuth2 access token from a service account ────────────────
//
// Flow:
//   1. Build a JWT signed with RS256 (service account private key)
//   2. POST the JWT to https://oauth2.googleapis.com/token
//   3. Return the resulting Bearer token (valid for 1 hour)

async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // JWT header + payload (both base64url encoded)
  const header  = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss:   sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  }));

  const signingInput = `${header}.${payload}`;

  // Import the RSA private key (PKCS8 PEM format from service account JSON)
  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const keyDer = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );

  // Sign the header.payload string with RS256
  const signatureBytes = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const signature = base64url(new Uint8Array(signatureBytes));
  const jwt = `${signingInput}.${signature}`;

  // Exchange the JWT for a Google access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }).toString(),
  });

  const tokenData = await tokenResp.json();

  if (!tokenData.access_token) {
    const detail = tokenData.error_description || tokenData.error || JSON.stringify(tokenData);
    throw new Error(`Google token exchange failed: ${detail}`);
  }

  return tokenData.access_token as string;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── Load and parse service account ──────────────────────────────────────
    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!saJson) {
      console.error("[optimize-routes] GOOGLE_SERVICE_ACCOUNT secret is not set");
      return new Response(
        JSON.stringify({ error: "GOOGLE_SERVICE_ACCOUNT secret is not configured. See deployment README." }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    let sa: ServiceAccount;
    try {
      sa = JSON.parse(saJson);
    } catch {
      return new Response(
        JSON.stringify({ error: "GOOGLE_SERVICE_ACCOUNT secret is not valid JSON." }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    if (!sa.client_email || !sa.private_key || !sa.project_id) {
      return new Response(
        JSON.stringify({ error: "GOOGLE_SERVICE_ACCOUNT is missing required fields (client_email, private_key, project_id)." }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ── Mint Google OAuth2 token ─────────────────────────────────────────────
    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken(sa);
    } catch (e) {
      console.error("[optimize-routes] Token error:", e);
      return new Response(
        JSON.stringify({ error: "Failed to authenticate with Google: " + (e as Error).message }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ── Read and forward the GMPRO request body ──────────────────────────────
    let requestBody: unknown;
    try {
      requestBody = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Request body is not valid JSON." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const googleUrl = `https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}:optimizeTours`;

    console.log(`[optimize-routes] Forwarding to Google — project: ${sa.project_id}`);

    const googleResp = await fetch(googleUrl, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = await googleResp.json();

    if (!googleResp.ok) {
      const msg = (responseData as any)?.error?.message || `HTTP ${googleResp.status}`;
      console.error(`[optimize-routes] Google API error ${googleResp.status}:`, msg);
    } else {
      const routeCount = (responseData as any)?.routes?.length ?? 0;
      console.log(`[optimize-routes] Google returned ${routeCount} routes`);
    }

    return new Response(JSON.stringify(responseData), {
      status:  googleResp.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[optimize-routes] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Unknown server error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});
