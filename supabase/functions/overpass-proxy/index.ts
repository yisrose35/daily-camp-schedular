// =============================================================================
// overpass-proxy — Supabase Edge Function
// =============================================================================
//
// Server-side proxy for the OpenStreetMap Overpass API.
//
// Browsers can't call Overpass directly from the Vercel deployment because
// Overpass omits CORS headers on error responses (429/406/503 etc.), so a
// transient rate-limit looks to the browser like a CORS violation. We proxy
// from a server with no origin-based restrictions and pass the JSON through.
//
// Tries the three public Overpass mirrors in order; returns the first
// successful response, with a server-side 45s timeout per mirror (well under
// the Supabase function cap but above Overpass's own 25s query timeout).
//
// REQUEST:
//   POST /functions/v1/overpass-proxy
//   Authorization: Bearer <supabase_user_access_token>
//   apikey: <supabase_anon_key>
//   Content-Type: application/json
//   Body: { "query": "[out:json][timeout:25];way[...](bbox);out body;>;out skel qt;" }
//
// RESPONSE:
//   200 — raw Overpass JSON
//   4xx/5xx — { error: string, details?: string }
//
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const PER_MIRROR_TIMEOUT_MS = 45000;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let query = "";
  try {
    const body = await req.json();
    query = (body?.query || "").toString();
  } catch (_) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!query || query.length > 50000) {
    return new Response(JSON.stringify({ error: "Missing or oversize query" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Overpass's usage policy requires a descriptive User-Agent identifying the
  // app; anonymous/default Deno traffic gets throttled with 406/429. Referer
  // gives the sysadmin a way to reach us if we misbehave.
  const UPSTREAM_HEADERS = {
    "User-Agent": "CampistryGo/1.0 (camp bus routing; https://github.com/yisrose35/daily-camp-schedular)",
    "Referer": "https://github.com/yisrose35/daily-camp-schedular",
    "Accept": "application/json",
  };

  const errors: { url: string; status?: number; message: string }[] = [];

  for (const url of MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_MIRROR_TIMEOUT_MS);
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          ...UPSTREAM_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!upstream.ok) {
        errors.push({ url, status: upstream.status, message: upstream.statusText });
        continue;
      }

      const text = await upstream.text();
      return new Response(text, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "X-Overpass-Mirror": url,
        },
      });
    } catch (e) {
      clearTimeout(timer);
      errors.push({ url, message: (e as Error).message });
    }
  }

  return new Response(
    JSON.stringify({ error: "All Overpass mirrors failed", details: errors }),
    {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  );
});
