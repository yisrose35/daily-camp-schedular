// @ts-nocheck
// =============================================================================
// camper-mail-inbox — turn a parent's plain email into a printable letter.
//
// Families already write letters inside Campistry Link; this is the other way
// in. A parent emails, from Gmail or anywhere, to the camp's own address:
//
//     letters+<inbound_token>@<the inbound domain>
//
// Resend receives it and POSTs an `email.received` webhook here. This function
// verifies it, works out which camp and which camper it is for, and drops it
// into the SAME link_camper_mail queue the Link letters use — so it shows up in
// Live's Camper Mail page next to everything else, ready for "Print all".
//
// ─────────────────────────────────────────────────────────────────────────────
// This endpoint is public (Resend is not a Supabase caller), so it is
// authenticated by the Svix signature and a routing token, then matched:
//
//   1. Svix signature over the RAW body — proves Resend sent it. The only
//      check that returns non-200; an unsigned request is not worth a retry.
//   2. The routing token in the To: address — proves which camp.
//   3. Which child: FIRST the camper code the parent typed —
//      <camp number>-<camper id> in the subject/body — which pins the letter to
//      the right child regardless of which address it came from (same reference
//      format as the deposit memo, migration 149); then the From: address
//      against the camp's parent list.
//
// A letter that can't be pinned to a child is stored as '(unassigned)' for the
// office to place, never dropped. A camp that gets flooded can turn on the
// known-parents-only gate, after which mail from an unknown address with no
// valid code is dropped instead.
//
// Once the signature passes it always answers 200: a non-2xx makes Resend
// redeliver, and the fingerprint would dedupe it but a webhook that is loudly
// "failing" while behaving correctly wastes far more time than a log.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CAMPER_MAIL_WEBHOOK_SECRET,
//      RESEND_API_KEY, (optional) RESEND_RECEIVING_URL
//
// WHY ITS OWN WEBHOOK SECRET, not RESEND_WEBHOOK_SECRET: Resend signs each
// webhook ENDPOINT with a different secret, but Supabase env vars are one value
// per project. deposit-inbox already owns RESEND_WEBHOOK_SECRET. Sharing the
// inbound domain means Resend delivers every inbound email to BOTH endpoints,
// each signed with its own secret, so this function needs its own secret to
// verify its own copy. (A `deposits+` email that reaches here fails the token
// lookup and is skipped; a `letters+` email that reaches deposit-inbox does the
// same there — the two never double-process.) Falls back to RESEND_WEBHOOK_SECRET
// for a single-endpoint pilot on a dedicated domain.
//
// This file is self-contained (the Dashboard deploy flattens a function to
// source/index.ts, so no local imports). Deploy it as the whole function.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── 1. Svix signature ────────────────────────────────────────────────────────
// Resend signs with the Standard Webhooks scheme: HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${raw body}`, keyed by the base64 secret after
// the `whsec_` prefix. The header may carry several space-separated `v1,<sig>`
// values during a secret rotation, so any one matching is a pass.
async function verifySvix(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("CAMPER_MAIL_WEBHOOK_SECRET") || Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[camper-mail-inbox] CAMPER_MAIL_WEBHOOK_SECRET is not set — refusing");
    return false;
  }
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 300) {
    console.warn("[camper-mail-inbox] timestamp outside the 5-minute window");
    return false;
  }

  try {
    const keyBytes = Uint8Array.from(
      atob(secret.replace(/^whsec_/, "")),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signed = new TextEncoder().encode(`${id}.${ts}.${rawBody}`);
    const mac = await crypto.subtle.sign("HMAC", key, signed);
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return sigHeader.split(" ").some((part) => {
      const [version, value] = part.split(",");
      return version === "v1" && value === expected;
    });
  } catch (e) {
    console.error("[camper-mail-inbox] signature verify failed", (e as Error).message);
    return false;
  }
}

// ── 2. reading the webhook payload ───────────────────────────────────────────
function pick(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// to/from arrive as a string, an array of strings, or objects with .address.
// Returns { email, name } pairs so we can keep the parent's display name.
function partiesOf(v: unknown): Array<{ email: string; name: string }> {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((item) => {
    if (typeof item === "string") return [parseParty(item)];
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const a = (o.address ?? o.email ?? o.value);
      const n = (o.name ?? "");
      if (typeof a === "string") {
        return [{ email: normEmail(a), name: String(n || "").trim() }];
      }
    }
    return [];
  });
}

// `Rivky Klein <rivky@gmail.com>` -> { name, email }
function parseParty(s: string): { email: string; name: string } {
  const m = String(s).match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || "").trim(), email: normEmail(m[2]) };
  return { name: "", email: normEmail(s) };
}

function normEmail(a: string): string {
  const m = String(a).toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/);
  return m ? m[0] : String(a).trim().toLowerCase();
}

/** `letters+ab12cd@inbound.example.com` -> `ab12cd` (also a bare token address) */
function tokenFromAddresses(addrs: string[]): string {
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/\+([a-z0-9]{8,64})@/);
    if (m) return m[1];
  }
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/^([a-z0-9]{16,64})@/);
    if (m) return m[1];
  }
  return "";
}

async function fetchBody(emailId: string): Promise<{ text: string; html: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey || !emailId) return { text: "", html: "" };
  const base = Deno.env.get("RESEND_RECEIVING_URL") ||
    "https://api.resend.com/emails/receiving";
  try {
    const res = await fetch(`${base}/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`[camper-mail-inbox] body fetch ${res.status} for ${emailId}`);
      return { text: "", html: "" };
    }
    const body = await res.json();
    const d = (body?.data ?? body) as Record<string, unknown>;
    return { text: pick(d, "text", "plain", "textBody"), html: pick(d, "html", "htmlBody") };
  } catch (e) {
    console.error("[camper-mail-inbox] body fetch failed", (e as Error).message);
    return { text: "", html: "" };
  }
}

// A letter is prose, not a bank alert — a plain, dependency-free HTML strip is
// all it needs. Keep paragraph breaks, drop everything else.
function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Which candidate did the parent name in the subject/body? Only decisive when
// exactly one candidate name appears — two children named, or none, and a human
// assigns it. Word-boundary match so "Ann" doesn't hit "Anna".
function pinByName(candidates: Array<any>, haystack: string): any | null {
  const hay = " " + String(haystack || "").toLowerCase() + " ";
  const hit = candidates.filter((c) => {
    const first = String(c.name || "").trim().split(/\s+/)[0] || "";
    if (!first) return false;
    const re = new RegExp("(^|[^a-z])" + first.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)");
    return re.test(hay) || hay.includes(" " + String(c.name).toLowerCase() + " ");
  });
  return hit.length === 1 ? hit[0] : null;
}

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();

  if (!(await verifySvix(req, rawBody))) {
    return json({ error: "invalid_signature" }, 401);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ ok: true, skipped: "unparseable_body" });
  }

  const type = String(event.type ?? "");
  if (type && type !== "email.received") {
    return json({ ok: true, skipped: `ignored_event:${type}` });
  }

  const data = (event.data ?? event) as Record<string, unknown>;
  const toParties = [...partiesOf(data.to), ...partiesOf(data.recipient), ...partiesOf(data.envelope_to)];
  const fromParties = [...partiesOf(data.from), ...partiesOf(data.sender)];
  const subject = pick(data, "subject");
  const emailId = pick(data, "email_id", "emailId", "id");
  const createdAt = pick(data, "created_at", "createdAt", "received_at");

  // Which camp?
  const token = tokenFromAddresses(toParties.map((p) => p.email));
  if (!token) {
    console.warn("[camper-mail-inbox] no routing token in", JSON.stringify(toParties.map((p) => p.email)));
    return json({ ok: true, skipped: "no_routing_token" });
  }

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: camp, error: campErr } = await service.rpc("_camper_mail_camp_for_token", {
    p_token: token,
  });
  if (campErr || !camp?.success) {
    console.warn("[camper-mail-inbox] unknown or disabled token");
    return json({ ok: true, skipped: "unknown_token" });
  }
  const campId = camp.campId as string;
  const campNumber = String(camp.campNumber || "").replace(/\D/g, "").replace(/^0+/, "");
  const knownParentsOnly = camp.knownParentsOnly === true;

  const sender = fromParties[0] || { email: "", name: "" };
  const senderEmail = sender.email;

  // Body: inline if present, otherwise fetched. Prefer text; fall back to HTML.
  let text = pick(data, "text", "plain");
  const html = pick(data, "html");
  if (!text && !html) {
    const fetched = await fetchBody(emailId);
    text = fetched.text || htmlToText(fetched.html);
  } else if (!text && html) {
    text = htmlToText(html);
  }
  // Keep the whole message — a forwarded letter's real text sits below the
  // forward's own From:/Subject: headers, so trimming "quoted" lines would throw
  // the letter itself away.
  const body = String(text || "").trim().slice(0, 20000);
  if (!body.trim()) {
    console.log(`[camper-mail-inbox] camp ${campId}: empty body — dropped`);
    return json({ ok: true, skipped: "empty_body" });
  }

  // ── who is this letter for? ────────────────────────────────────────────────
  // First the camper code the parent typed — <camp number>-<camper id>. It
  // works no matter which email address the letter came from, and the camp
  // number must match this camp's own before the second half is read as a
  // camper at all (a stray "718-555" or a date can't misfile a letter). Same
  // reference format as the deposit memo (migration 149).
  let chosen: any = null;
  let hadValidCode = false;
  if (campNumber) {
    const re = /([0-9]{3,6})\s*[-–—]\s*([0-9]{1,6})/g;
    let mm: RegExpExecArray | null;
    const hay = subject + "\n" + body;
    while ((mm = re.exec(hay)) !== null) {
      if (mm[1].replace(/^0+/, "") !== campNumber) continue;
      const byCode = await service.rpc("_camper_mail_by_camper_number", {
        p_camp_id: campId,
        p_camper_number: mm[2],
      });
      if (!byCode.error && byCode.data?.success && byCode.data.found) {
        chosen = byCode.data;
        hadValidCode = true;
        break;
      }
    }
  }

  // No code match → the sender's email against the camp's parent list. This is
  // also the spam gate: with known-parents-only ON, mail from an unknown address
  // and no valid code is dropped. OFF (the default), it's kept as unassigned.
  let candidates: Array<any> = [];
  if (!chosen) {
    const { data: cand, error: candErr } = await service.rpc("_camper_mail_candidates", {
      p_camp_id: campId,
      p_sender_email: senderEmail,
    });
    candidates = (!candErr && cand?.success && Array.isArray(cand.candidates)) ? cand.candidates : [];
    if (candidates.length === 1) chosen = candidates[0];
    else if (candidates.length > 1) chosen = pinByName(candidates, subject + "\n" + body);
  }

  if (!chosen && knownParentsOnly && candidates.length === 0 && !hadValidCode) {
    console.log(`[camper-mail-inbox] camp ${campId}: unknown sender ${senderEmail}, no code — dropped`);
    return json({ ok: true, skipped: "sender_not_a_known_parent" });
  }

  const parentName = (sender.name && sender.name.trim())
    || (senderEmail ? senderEmail.split("@")[0] : "");

  const fingerprint = "cm_" + (emailId || await sha1Hex([senderEmail, subject, createdAt, body.slice(0, 500)].join("|")));

  const rec = await service.rpc("_camper_mail_record", {
    p_camp_id: campId,
    p_fingerprint: fingerprint,
    p_camper_name: chosen ? chosen.name : "",
    // The lookups answer with the camper's id (migration 251); it decides.
    p_camper_id: chosen && chosen.camperId != null && /^\d+$/.test(String(chosen.camperId)) ? Number(chosen.camperId) : null,
    p_division: chosen ? chosen.division : "",
    p_grade: chosen ? chosen.grade : "",
    p_bunk: chosen ? chosen.bunk : "",
    p_parent_name: parentName,
    p_parent_email: senderEmail,
    p_subject: subject,
    p_body: body,
  });

  if (rec.error || !rec.data?.success) {
    console.error("[camper-mail-inbox] record failed", rec.error?.message || rec.data?.error);
    return json({ error: "record_failed" }, 500);
  }
  if (rec.data.duplicate) {
    return json({ ok: true, duplicate: true });
  }
  console.log(`[camper-mail-inbox] camp ${campId}: letter stored (${rec.data.assigned ? "assigned" : "unassigned"})`);
  return json({ ok: true, stored: true, assigned: !!rec.data.assigned });
});
