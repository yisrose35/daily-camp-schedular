// ============================================================================
// email-unsubscribe — CAN-SPAM one-click unsubscribe endpoint.
//
// Public GET endpoint (JWT verification off — this is a link clicked from
// an email client, never an authenticated Supabase session). Link shape:
//   .../functions/v1/email-unsubscribe?email=<enc>&t=<hmac>
// where t = HMAC-SHA256(lower(email), EMAIL_UNSUB_SECRET), hex, truncated to
// 32 chars — cheap tamper resistance without requiring auth. Also supports
// POST for RFC 8058 List-Unsubscribe-Post (one-click, no click-through page).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EMAIL_UNSUB_SECRET
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title>
     <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#334155}
     h1{font-size:1.3rem}p{color:#64748b}</style></head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const t = url.searchParams.get("t") || "";
  const secret = Deno.env.get("EMAIL_UNSUB_SECRET");

  if (!email || !secret) return html("<h1>Invalid link</h1>", 400);

  const expected = await hmacHex(secret, email);
  if (t !== expected) return html("<h1>Invalid or expired link</h1>", 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await supabase.from("email_unsubscribes").upsert({ email }, { onConflict: "email" });
  if (error) return html(`<h1>Something went wrong</h1><p>${error.message}</p>`, 500);

  return html(`<h1>You're unsubscribed</h1><p>${email} will no longer receive automated emails from Campistry camps.</p>`);
});
