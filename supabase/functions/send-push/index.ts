// =============================================================================
// send-push — deliver a push notification to a camp's parents
//
// Request:
//   { campId, pref, title, body, email?, data?, dryRun? }
//
//   pref   which notification preference this belongs to — one of
//          notifyMessages | notifyPayments | notifyCanteen | notifyPhotos |
//          notifyHealth. Parents who switched it off are not sent to. That
//          filtering happens in the database (push_targets_for_camp_v2), not
//          here, so a caller cannot bypass a parent's choice by forgetting to
//          check.
//   email  optional. A direct message is addressed to ONE family, so passing
//          the parent's email restricts delivery to that account's devices.
//          Omit it for a camp-wide announcement.
//   data   optional payload; data.page routes the app when the notification is
//          tapped (see campistry_push.js).
//
// Who may call:
//   * the service role (server-to-server, any camp), or
//   * a signed-in camp staff member, for THEIR OWN camp only — verified with
//     get_user_camp_id(), the same function the table RLS policies trust. This
//     is what lets the admin UI fire a notification when it sends a message,
//     without putting a service key in a browser.
//
// Android only, deliberately. Capacitor's push plugin returns an APNs token on
// iOS, not an FCM one, so iOS devices cannot be delivered through FCM without
// adding the Firebase iOS SDK to the app. They are counted and skipped rather
// than silently dropped, and will be handled by a direct APNs path once the
// .p8 key exists.
//
// Every response carries a `targets` breakdown. A send that reaches nobody is
// the single most confusing failure this system has, because the phone looks
// perfectly healthy: permission granted, token registered, app installed. The
// counts say which of the four possible reasons it actually was.
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
  "pickupAlert",
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

// ── Authorization ────────────────────────────────────────────────────────────
// Returns true when the bearer token belongs to a staff member whose active
// camp IS the camp being sent to. Anything else — a parent's session, another
// camp's staff, an expired token — is false.
async function isStaffOfCamp(url: string, anonKey: string, jwt: string, campId: string) {
  try {
    const asUser = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await asUser.rpc("get_user_camp_id");
    if (error) return false;
    return !!data && String(data) === String(campId);
  } catch (_) {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
      || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
      || serviceKey;
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!serviceKey || !auth) return json({ success: false, error: "forbidden" }, 403);

    const { campId, pref, title, body, email, data, dryRun, staffEmails } = await req.json();
    if (!campId) return json({ success: false, error: "missing_campId" }, 400);
    if (!VALID_PREFS.has(pref)) return json({ success: false, error: "invalid_pref" }, 400);
    if (!title && !body) return json({ success: false, error: "empty_notification" }, 400);

    // Service role may send anywhere; a staff session only to its own camp.
    // The camp check happens before anything else reads device tokens.
    const asService = auth === serviceKey;
    if (!asService && !(await isStaffOfCamp(supabaseUrl, anonKey, auth, campId))) {
      return json({ success: false, error: "forbidden" }, 403);
    }

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

    const db = createClient(supabaseUrl, serviceKey);

    // Two entirely separate targeting paths under one send loop: staffEmails
    // routes to staff (Division Head / bunk staff / league captain alerts —
    // there is no parent-style invite/preference gate for staff, and no
    // per-notification opt-out for this alert type, given the safety
    // context), while everything else keeps the existing parent-targeting
    // path untouched.
    const isStaffTarget = Array.isArray(staffEmails) && staffEmails.length > 0;
    let android: any[] = [];
    let targets: Record<string, unknown>;
    let reason: string | null = null;

    if (isStaffTarget) {
      const { data: staffRows, error: staffErr } = await db.rpc("push_targets_for_staff_emails", {
        p_camp_id: campId,
        p_emails: staffEmails,
      });
      if (staffErr) return json({ success: false, error: staffErr.message }, 500);
      const known = staffRows || [];
      android = known.filter((t: any) => t.platform === "android");
      targets = {
        devicesKnownToCamp: known.length,
        eligible: known.length,
        android: android.length,
        ios: known.length - android.length,
      };
      if (!android.length) {
        reason = !known.length
          ? "none of the given staff emails have a registered device"
          : "the only matching devices are iOS, which is not wired to FCM yet";
      }
    } else {
      const { data: rows, error } = await db.rpc("push_targets_for_camp_v2", {
        p_camp_id: campId,
        p_pref: pref,
        p_email: email || null,
      });
      if (error) return json({ success: false, error: error.message }, 500);

      // ── Why a send reaches who it reaches ──────────────────────────────
      // Every device this camp knows about, split by the reason it qualifies
      // or does not. Computed even on a successful send, because "sent: 1"
      // when eight parents were expected is just as wrong as "sent: 0".
      const known = rows || [];
      const eligible = known.filter((t: any) => t.invite_active && t.pref_on && t.email_match);
      android = eligible.filter((t: any) => t.platform === "android");
      targets = {
        devicesKnownToCamp: known.length,
        excludedByRevokedInvite: known.filter((t: any) => !t.invite_active).length,
        excludedByPreference: known.filter((t: any) => t.invite_active && !t.pref_on).length,
        excludedByEmail: known.filter((t: any) => t.invite_active && t.pref_on && !t.email_match).length,
        eligible: eligible.length,
        android: android.length,
        ios: eligible.length - android.length,
      };

      // Name the reason rather than leaving the caller to compare numbers.
      if (!android.length) {
        if (!(targets.devicesKnownToCamp as number)) reason = "no parent at this camp has registered a device";
        else if ((targets.excludedByEmail as number) === (targets.devicesKnownToCamp as number) - (targets.excludedByRevokedInvite as number) - (targets.excludedByPreference as number) && email) reason = `no registered device belongs to ${email}`;
        else if ((targets.excludedByRevokedInvite as number) && !(targets.eligible as number)) reason = "every registered device belongs to a parent whose invite is revoked or expired";
        else if ((targets.excludedByPreference as number) && !(targets.eligible as number)) reason = "every eligible parent switched this notification off";
        else if (targets.ios) reason = "the only eligible devices are iOS, which is not wired to FCM yet";
        else reason = "no eligible Android device";
      }
    }

    if (dryRun) return json({ success: true, dryRun: true, wouldSend: android.length, targets, reason });
    if (!android.length) return json({ success: true, sent: 0, failed: 0, targets, reason });

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
            // priority:HIGH only controls how fast FCM wakes the device. What
            // decides whether the phone makes a sound and drops a banner down
            // is the CHANNEL, and naming one here is the whole difference
            // between a notification that announces itself and one that
            // appears silently in the shade an hour later. The channel is
            // created by the app (campistry_push.js) at IMPORTANCE_HIGH.
            android: {
              priority: "HIGH",
              notification: {
                channel_id: "campistry_alerts",
                sound: "default",
                default_vibrate_timings: true,
                // Pre-Oreo devices have no channels; this is what gives them
                // the same heads-up behaviour.
                notification_priority: "PRIORITY_HIGH",
              },
            },
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
      targets,
      errors: failures.slice(0, 5),
    });
  } catch (e) {
    return json({ success: false, error: String(e?.message || e) }, 500);
  }
});
