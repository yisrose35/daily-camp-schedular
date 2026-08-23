// ============================================================================
// telnyx-sms-webhook — inbound SMS handler for STOP/opt-out compliance.
//
// Registered as the Messaging Profile's inbound webhook URL in the Telnyx
// portal. Public endpoint (JWT verification off — Telnyx isn't a Supabase
// caller) — authenticated instead by Telnyx's Ed25519 request signature.
//
// On STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT (case-insensitive, whole
// message body), upserts sms_opt_outs by phone_key. Best-effort secondary
// step flips smsEmailConsent:false on any matching roster/bunkStaff record
// so the admin UI reflects it — sms_opt_outs remains the authoritative gate
// even if that secondary write fails.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELNYX_PUBLIC_KEY
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, telnyx-signature-ed25519, telnyx-timestamp",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

const STOP_RE = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i;

function phoneKey(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const publicKeyB64 = Deno.env.get("TELNYX_PUBLIC_KEY");
  if (!publicKeyB64) return false; // refuse rather than accept an unverifiable webhook
  const signatureB64 = req.headers.get("telnyx-signature-ed25519");
  const timestamp = req.headers.get("telnyx-timestamp");
  if (!signatureB64 || !timestamp) return false;

  try {
    const keyBytes = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
    const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    const signedPayload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify("Ed25519", cryptoKey, sigBytes, signedPayload);
  } catch (e) {
    console.error("[telnyx-sms-webhook] signature verify failed", (e as Error).message);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const rawBody = await req.text();
  const ok = await verifySignature(req, rawBody);
  if (!ok) return json({ error: "invalid signature" }, 401);

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "invalid json" }, 400); }

  const eventType = payload?.data?.event_type;
  if (eventType !== "message.received") return json({ ok: true, ignored: eventType });

  const msg = payload.data.payload || {};
  const from = msg.from?.phone_number || "";
  const text = String(msg.text || "").trim();
  if (!STOP_RE.test(text)) return json({ ok: true, matched: false });

  const key = phoneKey(from);
  if (!key) return json({ ok: true, matched: true, error: "unparseable phone" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { error: upsertErr } = await supabase
    .from("sms_opt_outs")
    .upsert({ phone_key: key, phone_raw: from, source: "telnyx_stop" }, { onConflict: "phone_key" });
  if (upsertErr) {
    console.error("[telnyx-sms-webhook] opt-out upsert failed", upsertErr.message);
    return json({ error: upsertErr.message }, 500);
  }

  // Best-effort: flip smsEmailConsent:false on any matching family/staff
  // record so the admin UI reflects it. Never let a failure here affect the
  // authoritative sms_opt_outs write above.
  try {
    const { data: rows } = await supabase
      .from("camp_state_kv")
      .select("camp_id, key, value")
      .eq("key", "campistryMe");
    for (const row of rows || []) {
      const me = row.value || {};
      let changed = false;
      const matchesPhone = (p: unknown) => phoneKey(p) === key;
      Object.values<any>(me.families || {}).forEach((f: any) => {
        (f?.households || []).forEach((hh: any) => {
          (hh?.parents || []).forEach((p: any) => {
            if (matchesPhone(p?.phone) && p.smsEmailConsent !== false) { p.smsEmailConsent = false; changed = true; }
          });
        });
      });
      Object.values<any>(me.bunkStaff || {}).forEach((list: any) => {
        (Array.isArray(list) ? list : []).forEach((s: any) => {
          if (matchesPhone(s?.phone) && s.smsEmailConsent !== false) { s.smsEmailConsent = false; changed = true; }
        });
      });
      if (changed) {
        await supabase.from("camp_state_kv").update({ value: me }).eq("camp_id", row.camp_id).eq("key", "campistryMe");
      }
    }
  } catch (e) {
    console.error("[telnyx-sms-webhook] best-effort consent flip failed", (e as Error).message);
  }

  return json({ ok: true, matched: true, opted_out: key });
});
