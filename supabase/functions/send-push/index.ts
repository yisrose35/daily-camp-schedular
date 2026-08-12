// =============================================================================
// send-push — deliver a push notification to a camp's parents
//
// Request (service-role only):
//   { campId, pref, title, body, data?, dryRun? }
//
//   pref   which notification preference this belongs to — one of
//          notifyMessages | notifyPayments | notifyCanteen | notifyPhotos |
//          notifyHealth. Parents who switched it off are not sent to. That
//          filtering happens in the database (push_targets_for_camp), not here,
//          so a caller cannot bypass a parent's choice by forgetting to check.
//   data   optional payload; data.page routes the app when the notification is
//          tapped (see campistry_push.js).
//
// Android only, deliberately. Capacitor's push plugin returns an APNs token on
// iOS, not an FCM one, so iOS devices cannot be delivered through FCM without
// adding the Firebase iOS SDK to the app. They are counted and skipped rather
// than silently dropped, and will be handled by a direct APNs path once the
// .p8 key exists.
//
// Secrets: FCM_SERVICE_ACCOUNT (the Firebase service-account JSON),
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by the platform).
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_PREFS = new Set([
  "notifyMessages", "notifyPayments", "notifyCanteen", "notifyPhotos", "notifyHealth",
]);

// ── Google OAuth: service account → access token ─────────────────────────────
// Cached across invocations while the container is warm; tokens last an hour
// and minting one per notification would add a round trip to every send.
let cachedToken: { value: string; expiresAt: number } | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(sa: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  // The JSON stores the PEM with escaped newlines; importKey needs real ones.
  const pem = String(sa.private_key || "").replace(/\\n/g, "\n");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error("google_oauth_failed: " + (json.error_description || json.error || res.status));
  }
  cachedToken = { value: json.access_token, expiresAt: now + (json.expires_in || 3600) };
  return cachedToken.value;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // Only the service role may send. Without this, anyone holding the anon key
    // could push arbitrary text to every parent at a camp.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!serviceKey || auth !== serviceKey) {
      return json({ success: false, error: "forbidden" }, 403);
    }

    const { campId, pref, title, body, data, dryRun } = await req.json();
    if (!campId) return json({ success: false, error: "missing_campId" }, 400);
    if (!VALID_PREFS.has(pref)) return json({ success: false, error: "invalid_pref" }, 400);
    if (!title && !body) return json({ success: false, error: "empty_notification" }, 400);

    const saRaw = Deno.env.get("FCM_SERVICE_ACCOUNT");
    if (!saRaw) return json({ success: false, error: "missing FCM_SERVICE_ACCOUNT secret" }, 500);
    let sa: Record<string, string>;
    try {
      sa = JSON.parse(saRaw);
    } catch {
      // The commonest setup mistake is pasting the Admin SDK code snippet
      // instead of the downloaded key file — say so plainly.
      return json({ success: false, error: "FCM_SERVICE_ACCOUNT is not valid JSON — paste the downloaded service-account file, not the code snippet" }, 500);
    }
    if (!sa.project_id || !sa.client_email || !sa.private_key) {
      return json({ success: false, error: "FCM_SERVICE_ACCOUNT missing project_id/client_email/private_key" }, 500);
    }

    const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
    const { data: targets, error } = await db.rpc("push_targets_for_camp", {
      p_camp_id: campId,
      p_pref: pref,
    });
    if (error) return json({ success: false, error: error.message }, 500);

    const all = targets || [];
    const android = all.filter((t: any) => t.platform === "android");
    const skippedIos = all.length - android.length;

    if (dryRun) {
      return json({ success: true, dryRun: true, wouldSend: android.length, skippedIos });
    }
    if (!android.length) {
      return json({ success: true, sent: 0, failed: 0, skippedIos, note: "no opted-in Android devices" });
    }

    const token = await getAccessToken(sa);
    const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

    let sent = 0;
    const stale: string[] = [];
    const failures: string[] = [];

    // FCM v1 has no multicast endpoint; one request per device is the supported
    // shape. Chunked so a camp with hundreds of parents does not open hundreds
    // of sockets at once.
    const CHUNK = 20;
    for (let i = 0; i < android.length; i += CHUNK) {
      const slice = android.slice(i, i + CHUNK);
      await Promise.all(slice.map(async (t: any) => {
        const message = {
          message: {
            token: t.token,
            notification: { title: title || "", body: body || "" },
            // Data values must be strings; anything else is rejected outright.
            data: Object.fromEntries(
              Object.entries(data || {}).map(([k, v]) => [k, String(v)]),
            ),
            android: { priority: "HIGH" },
          },
        };
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        if (r.ok) { sent++; return; }
        const err = await r.text();
        // An uninstalled app or a rotated token answers UNREGISTERED/NOT_FOUND.
        // Those rows are dead weight and are removed, or every future send
        // retries them forever.
        if (r.status === 404 || /UNREGISTERED|NOT_FOUND|InvalidRegistration/i.test(err)) {
          stale.push(t.token);
        } else {
          failures.push(`${r.status}: ${err.slice(0, 140)}`);
        }
      }));
    }

    if (stale.length) {
      await db.from("link_push_tokens").delete().in("token", stale);
    }

    return json({
      success: true,
      sent,
      failed: failures.length,
      removedStale: stale.length,
      skippedIos,
      errors: failures.slice(0, 5),
    });
  } catch (e) {
    return json({ success: false, error: String(e?.message || e) }, 500);
  }
});
