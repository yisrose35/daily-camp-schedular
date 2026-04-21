// =============================================================================
// optimize-routes — Supabase Edge Function
// =============================================================================
//
// Proxies requests to the Google Route Optimization API (GMPRO) using
// OAuth2 user credentials (refresh token flow).
//
// WHY THIS EXISTS:
//   The GMPRO API is a Google Cloud API that requires an OAuth2 Bearer token.
//   It rejects simple API keys from browser requests. This edge function runs
//   server-side in Deno, holds OAuth2 credentials as secrets, exchanges a
//   stored refresh token for a short-lived Bearer token, and forwards the
//   routing request to Google.
//
// REQUIRED SUPABASE SECRETS (set in Supabase dashboard → Edge Functions → Secrets):
//   GOOGLE_OAUTH_CLIENT_ID      — OAuth 2.0 Client ID
//   GOOGLE_OAUTH_CLIENT_SECRET  — OAuth 2.0 Client Secret
//   GOOGLE_OAUTH_REFRESH_TOKEN  — long-lived refresh token (from OAuth Playground)
//   GOOGLE_PROJECT_ID           — Google Cloud Project ID
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

// ─── Mint a Google OAuth2 access token using the refresh token flow ───────────
//
// Flow:
//   POST to token endpoint with client credentials + refresh token
//   → returns a short-lived access token (valid ~1 hour)

async function getGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
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
    // ── Load secrets ─────────────────────────────────────────────────────────
    const clientId     = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
    const refreshToken = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN");
    const projectId    = Deno.env.get("GOOGLE_PROJECT_ID");

    const missing = [
      !clientId     && "GOOGLE_OAUTH_CLIENT_ID",
      !clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET",
      !refreshToken && "GOOGLE_OAUTH_REFRESH_TOKEN",
      !projectId    && "GOOGLE_PROJECT_ID",
    ].filter(Boolean);

    if (missing.length > 0) {
      console.error("[optimize-routes] Missing secrets:", missing.join(", "));
      return new Response(
        JSON.stringify({ error: `Missing Supabase secrets: ${missing.join(", ")}` }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // ── Mint Google OAuth2 token ─────────────────────────────────────────────
    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken(clientId!, clientSecret!, refreshToken!);
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

    const googleUrl = `https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(projectId!)}:optimizeTours`;

    console.log(`[optimize-routes] Forwarding to Google — project: ${projectId}`);

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
