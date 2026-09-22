// =============================================================================
// send-broadcast — Deliver broadcast emails/SMS to camp families
//
// Request: { campId, to: [{email, name, phone, consent}], subject, body,
//            method, campName, branding?, eventKey? }
// `branding` (optional) is the camp's Link message/email branding object
// (logo/brandColor/footer/watermark) — when the client passes it, the sent
// email matches the composer's live preview exactly (see
// campistry_link_branding.js and buildBrandedEmailHtml below). Omitted
// (existing callers that predate this) → falls back to default branding.
// Methods: 'email', 'sms', 'all'
//
// Security: JWT-verified (Supabase default) + re-checks the caller's camp
// role server-side via get_user_role() (owner/admin/scheduler only, same
// pattern as send-sms/index.ts). Every recipient must be consented
// (`consent:true`, resolved by the caller from smsEmailConsent on the
// roster/family/staff record — this function trusts that flag but is the
// last line of defense against sms_opt_outs/email_unsubscribes regardless
// of what the caller passed) and not present in the opt-out/unsubscribe
// tables, checked with the service-role key so a client can never bypass
// them. Phone numbers are also re-verified against the caller's own camp
// (same phoneKey()/campPhoneBook approach as send-sms) before an SMS goes
// out — consent alone isn't proof a number actually belongs to this camp.
//
// Idempotency: pass eventKey to avoid double-sending the same broadcast to
// the same recipient on retry — reuses the notifications table (migration
// 056) exactly as its own comment prescribes.
//
// Secrets: RESEND_API_KEY, FROM_EMAIL, TELNYX_API_KEY,
//   TELNYX_FROM_NUMBER or TELNYX_MESSAGING_PROFILE_ID,
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_FROM = Deno.env.get("TELNYX_FROM_NUMBER");
const TELNYX_PROFILE = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
// campistry.org — the app's actual domain (link./snacks.campistry.org).
// The old default said campistry.com, which Campistry does not own: with
// FROM_EMAIL unset that sends from an unverified domain, so Resend rejects
// it or the mail fails DKIM/SPF alignment and lands in spam. Set FROM_EMAIL
// explicitly in Edge Function secrets; this default is only a safety net.
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Campistry <noreply@campistry.org>";
const EMAIL_UNSUB_SECRET = Deno.env.get("EMAIL_UNSUB_SECRET");
const SENDER_ROLES = ["owner", "admin", "scheduler"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// ── Branding-aware email template — mirrors campistry_link_branding.js's
// buildEmailHtml()/headerHtml()/footerHtml()/watermarkStyle() so the
// Broadcast composer's live preview (built client-side from the exact same
// `branding` object) matches what recipients actually receive. Ported here
// rather than imported — a Deno edge function can't import a browser
// <script> file directly, no supabase/functions/_shared/ exists in this
// project — so keep this structurally in sync with campistry_link_branding.js
// if either changes.
function escHtml(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function isSafeImage(s: unknown): boolean {
  return typeof s === "string" && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}
function isColorStr(s: unknown): boolean {
  return typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s);
}
type Branding = { logo: string; brandColor: string; footer: string; header: string; watermark: any };
function normalizeBranding(raw: any): Branding {
  const b = (raw && typeof raw === "object") ? raw : {};
  const w = (b.watermark && typeof b.watermark === "object") ? b.watermark : {};
  const size = Number(w.size);
  return {
    logo: isSafeImage(b.logo) ? b.logo : "",
    brandColor: isColorStr(b.brandColor) ? b.brandColor : "#2A7A35",
    footer: typeof b.footer === "string" ? b.footer : "",
    header: (b.header === "plain" || b.header === "none") ? b.header : "bar",
    watermark: {
      enabled: !!w.enabled,
      rendered: isSafeImage(w.rendered) ? w.rendered : "",
      image: isSafeImage(w.image) ? w.image : "",
      source: (w.source === "custom" || w.source === "text") ? w.source : "logo",
      size: Number.isFinite(size) ? Math.min(100, Math.max(15, size)) : 55,
      position: (w.position === "tile" || w.position === "corner") ? w.position : "center",
    },
  };
}
function watermarkStyle(b: Branding): string {
  const w = b.watermark;
  if (!w?.enabled) return "";
  const img = w.rendered || (w.source === "custom" ? w.image : b.logo);
  if (!isSafeImage(img)) return "";
  let css = `background-image:url(${img});`;
  if (w.position === "tile") css += `background-repeat:repeat;background-position:center;background-size:${Math.max(12, Math.round(w.size / 2))}% auto;`;
  else if (w.position === "corner") css += `background-repeat:no-repeat;background-position:right bottom;background-size:${w.size}% auto;`;
  else css += `background-repeat:no-repeat;background-position:center center;background-size:${w.size}% auto;`;
  return css;
}
function brandHeaderHtml(b: Branding, campName: string): string {
  if (b.header === "none") return "";
  const logo = isSafeImage(b.logo)
    ? `<img src="${b.logo}" alt="" width="170" style="max-height:52px;max-width:170px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto 6px;border:0;">`
    : "";
  if (b.header === "plain") {
    return `<div style="padding:14px 0 10px;text-align:center;border-bottom:2px solid ${b.brandColor};">${logo}<div style="font-weight:700;font-size:15px;color:${b.brandColor};">${escHtml(campName)}</div></div>`;
  }
  return `<div style="background:${b.brandColor};padding:14px 18px;text-align:center;">${logo}<div style="font-weight:700;font-size:15px;color:#ffffff;letter-spacing:.01em;">${escHtml(campName)}</div></div>`;
}
function brandFooterHtml(b: Branding): string {
  if (!b.footer) return "";
  return `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.55;color:#64748b;white-space:pre-wrap;">${escHtml(b.footer)}</div>`;
}
// Turn plain URLs in an already-escaped body into clickable links, so a form
// link (or any link) the camp writes in a message is actually clickable.
function linkifyHtml(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (u) => `<a href="${u}" style="color:#2563eb;text-decoration:underline;">${u}</a>`);
}
function buildBrandedEmailHtml(o: { subject?: string; body?: string; branding?: any; campName?: string; unsubLink?: string; campAddress?: string }): string {
  const b = normalizeBranding(o.branding);
  const campName = o.campName || "Camp";
  const wm = watermarkStyle(b);
  const bodyBg = wm ? `background-color:#ffffff;${wm}` : "background-color:#ffffff;";
  const extras = [
    o.unsubLink ? `<a href="${o.unsubLink}" style="color:#94a3b8;">Unsubscribe</a>` : "",
    o.campAddress ? escHtml(o.campAddress) : "",
  ].filter(Boolean).join(" · ");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(o.subject || campName)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
<tr><td align="center" style="padding:22px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td>${brandHeaderHtml(b, campName)}</td></tr>
<tr><td style="${bodyBg}padding:26px 28px 30px;">
${o.subject ? `<div style="font-size:17px;font-weight:700;color:#0f172a;margin:0 0 12px;">${escHtml(o.subject)}</div>` : ""}
<div style="font-size:14.5px;line-height:1.65;color:#334155;white-space:pre-wrap;">${linkifyHtml(escHtml(o.body || ""))}</div>
${brandFooterHtml(b)}
</td></tr>
<tr><td style="padding:14px 20px;background:#f8fafc;text-align:center;font-size:11px;color:#94a3b8;">Sent by ${escHtml(campName)} via Campistry${extras ? ` · ${extras}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
}

function phoneKey(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function normalizePhone(raw: unknown): string | null {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

async function callerRole(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_role`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: authHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return null;
  const role = await res.json();
  return typeof role === "string" ? role : null;
}

// Every phone number that belongs to this camp — same shape as send-sms's
// campPhoneBook, scoped by the caller's own JWT/RLS.
async function campPhoneBook(req: Request): Promise<Set<string> | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/camp_state_kv?select=key,value&key=in.(app1,campistryMe)`,
    { headers: { apikey: anonKey, Authorization: authHeader } },
  );
  if (!res.ok) return null;
  let rows: Array<{ key: string; value: any }>;
  try { rows = await res.json(); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const byKey: Record<string, any> = {};
  rows.forEach((r) => { byKey[r.key] = r.value; });
  const me = byKey.campistryMe || {};
  const book = new Set<string>();
  const add = (v: unknown) => { const k = phoneKey(v); if (k) book.add(k); };
  const roster = byKey.app1?.camperRoster || {};
  Object.values<any>(roster).forEach((c) => { add(c?.parent1Phone); add(c?.parent2Phone); add(c?.emergencyPhone); });
  Object.values<any>(me.bunkStaff || {}).forEach((list: any) => (Array.isArray(list) ? list : []).forEach((s: any) => add(s?.phone)));
  Object.values<any>(me.families || {}).forEach((f: any) => (f?.households || []).forEach((hh: any) => (hh?.parents || []).forEach((p: any) => add(p?.phone))));
  return book;
}

// ── Pacing, concurrency and retry ───────────────────────────────────────────
//
// The send loop used to be strictly serial with a deliberate 100ms sleep after
// every recipient, plus one awaited `notifications` INSERT per recipient before
// it. At roughly half a second each for email + SMS, a broadcast to 400
// families needed ~200 seconds and was killed by the platform's wall clock part
// way through — the exact size of camp this feature exists for.
//
// Concurrency alone is not the fix, because the sleep was doing a job: it kept
// the request rate under the providers' limits. So pacing is now explicit (a
// shared rate gate per provider) and separate from concurrency (a worker pool
// that hides each call's latency). Throughput becomes the rate limit instead of
// one-over-latency, and both numbers are env-tunable from the Dashboard without
// touching this file.
const CONCURRENCY = Math.max(1, Number(Deno.env.get("BROADCAST_CONCURRENCY") || 6));
const EMAIL_PER_SEC = Math.max(1, Number(Deno.env.get("BROADCAST_EMAIL_PER_SEC") || 8));
const SMS_PER_SEC = Math.max(1, Number(Deno.env.get("BROADCAST_SMS_PER_SEC") || 8));
// Leaves headroom under the platform's wall-clock limit so the function can
// report an honest partial result instead of being killed mid-send.
const BUDGET_MS = Math.max(5000, Number(Deno.env.get("BROADCAST_BUDGET_MS") || 100000));

/** Spaces calls out so no more than `perSecond` start in any second. */
function rateGate(perSecond: number) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const n = i++;
        if (n >= items.length) return;
        await worker(items[n]);
      }
    }),
  );
}

type SendResult = { ok: boolean; error?: string; retryable?: boolean };

/**
 * Retries a transient provider failure instead of counting it as a permanent
 * one. A rate-limit rejection used to mark that parent as failed for good —
 * and because the idempotency marker had already been written, retrying the
 * whole broadcast skipped them for ever. So a 429 silently cost a family the
 * message at exactly the recipient counts where 429s start happening.
 */
async function withRetry(send: () => Promise<SendResult>, tries = 3): Promise<SendResult> {
  let last: SendResult = { ok: false, error: "not attempted" };
  for (let attempt = 0; attempt < tries; attempt++) {
    last = await send();
    if (last.ok || !last.retryable) return last;
    // 0.5s, 1.5s — short enough to stay inside the budget, long enough for a
    // per-second rate window to roll over.
    await new Promise((r) => setTimeout(r, 500 + attempt * 1000));
  }
  return last;
}

/** Whether a provider's rejection is worth trying again. */
function isRetryable(status: number | undefined, message: string): boolean {
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  return /rate.?limit|too many requests|timeout|temporar|econnreset|socket|network/i.test(message);
}

async function sendTelnyxSMS(to: string, body: string, fromNumber?: string): Promise<SendResult> {
  // A camp's own number (Dashboard → Camp Profile → SMS Sending Number)
  // takes priority — isolates deliverability/reputation per camp instead of
  // every camp sharing one platform-wide number. Falls back to the shared
  // TELNYX_FROM_NUMBER/TELNYX_MESSAGING_PROFILE_ID for camps that haven't
  // set up their own yet.
  const effectiveFrom = fromNumber || TELNYX_FROM;
  if (!TELNYX_API_KEY || (!effectiveFrom && !TELNYX_PROFILE)) return { ok: false, error: "SMS not configured" };
  try {
    const payload: Record<string, unknown> = { to, text: body.slice(0, 1600) };
    // A camp's own number always wins. Otherwise defer to whichever the
    // platform has configured — a shared Messaging Profile (if set) over a
    // shared bare number, matching the original platform-wide priority.
    if (fromNumber) payload.from = fromNumber;
    else if (TELNYX_PROFILE) payload.messaging_profile_id = TELNYX_PROFILE;
    else payload.from = TELNYX_FROM;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    const msg = data?.errors?.[0]?.detail || `Telnyx error ${res.status}`;
    return { ok: false, error: msg, retryable: isRetryable(res.status, msg) };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: msg, retryable: isRetryable(undefined, msg) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { campId, to, subject, body, method, campName, branding, eventKey } = await req.json();
    if (!campId) return json({ error: "campId required" }, 400);
    if (!to?.length || !body) return json({ error: "to and body required" }, 400);

    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return json({ error: "Not authorized to send broadcasts (owner/admin/scheduler only)." }, 403);
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // The client-side check (campistry_me.js's _emailServiceOn()) is what
    // shows the office a friendly "not in your plan" message before they
    // even try — this is the real gate, since a client-side-only check can
    // be skipped by anyone calling this function directly with a valid
    // token. Same _camp_may_send_email(camp_id) RPC migration 196 defines
    // for exactly this purpose.
    const { data: mayEmail, error: mayEmailErr } = await supabase.rpc("_camp_may_send_email", { p_camp_id: campId });
    if (mayEmailErr) {
      console.error("[send-broadcast] email-gate check failed:", mayEmailErr.message);
      return json({ error: "Could not verify this camp's emailing plan." }, 500);
    }
    if (!mayEmail) {
      return json({ error: "This camp's plan doesn't include emailing. Contact Campistry to add it." }, 403);
    }

    // Overall logo/branding: when the caller doesn't pass one (or passes one
    // with no logo), fall back to the camp's own saved Link branding, so every
    // email — acceptance notes, receipts, broadcasts — carries the camp's logo
    // without each send path having to remember to attach it.
    let brandingResolved: any = branding;
    if ((method === "email" || method === "all" || method === "All Channels" || method === "Email")
        && (!brandingResolved || !brandingResolved.logo)) {
      try {
        const { data: kv } = await supabase.from("camp_state_kv").select("value")
          .eq("camp_id", campId).eq("key", "campistryLink").maybeSingle();
        const stored = (kv?.value as any)?.settings?.branding || (kv?.value as any)?.branding;
        if (stored && stored.logo) brandingResolved = stored;
      } catch (_e) { /* keep whatever was passed */ }
    }

    const results = { emailSent: 0, emailFailed: 0, emailSkipped: 0, smsSent: 0, smsFailed: 0, smsSkipped: 0 };
    const sendEmail = method === "email" || method === "all" || method === "All Channels" || method === "Email";
    const sendSms = method === "sms" || method === "SMS" || method === "all" || method === "All Channels";

    const phoneBook = sendSms ? await campPhoneBook(req) : null;

    // Each camp's own mailing address (CAN-SPAM footer), contact email
    // (Reply-To, so a parent's reply reaches the camp's real inbox, not a
    // noreply@ mailbox), and SMS sending number (own deliverability/
    // reputation instead of sharing the platform-wide number) — all set on
    // the Dashboard's Camp Profile card. Address/number fall back to
    // platform-wide defaults for camps that haven't filled theirs in yet.
    let campAddress = "";
    let campReplyTo: string | undefined;
    let campTelnyxNumber: string | undefined;
    if (sendEmail || sendSms) {
      const { data: campRow } = await supabase.from("camps").select("address, contact_email, telnyx_from_number").eq("id", campId).maybeSingle();
      campAddress = campRow?.address || Deno.env.get("POSTAL_ADDRESS") || "";
      campReplyTo = campRow?.contact_email || undefined;
      campTelnyxNumber = campRow?.telnyx_from_number || undefined;
    }

    // Pull opt-out/unsubscribe lists once up front — small tables, cheap to
    // scan in full rather than one round-trip per recipient.
    const phoneKeys = new Set((to as any[]).map((r) => phoneKey(r.phone)).filter(Boolean) as string[]);
    const emails = new Set((to as any[]).map((r) => String(r.email || "").toLowerCase()).filter(Boolean));
    const [{ data: optOuts }, { data: unsubs }] = await Promise.all([
      phoneKeys.size ? supabase.from("sms_opt_outs").select("phone_key").in("phone_key", Array.from(phoneKeys)) : Promise.resolve({ data: [] as any[] }),
      emails.size ? supabase.from("email_unsubscribes").select("email").in("email", Array.from(emails)) : Promise.resolve({ data: [] as any[] }),
    ]);
    const optedOutPhones = new Set((optOuts || []).map((r: any) => r.phone_key));
    const unsubscribedEmails = new Set((unsubs || []).map((r: any) => r.email));

    const unsubLink = async (email: string) => {
      if (!EMAIL_UNSUB_SECRET) return "";
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(EMAIL_UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.toLowerCase()));
      const t = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      const base = Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".functions.supabase.co");
      return `${base}/email-unsubscribe?email=${encodeURIComponent(email)}&t=${t}`;
    };

    // ── Consent, in one pass, before anything costs a round trip ────────────
    // Default-allow when consent isn't specified at all — existing callers
    // (post-acceptance form links, a parent's own transactional emails
    // they triggered by applying/enrolling) predate this field and are
    // relationship/transactional mail, not the unsolicited marketing-style
    // sends this gate exists for. Only an EXPLICIT consent:false (the new
    // composer fallback passing a non-consenting non-adopter) is skipped.
    const consented: any[] = [];
    for (const recipient of to as any[]) {
      if (recipient.consent === false) {
        if (recipient.email) results.emailSkipped++;
        if (recipient.phone) results.smsSkipped++;
        continue;
      }
      consented.push(recipient);
    }

    // ── Idempotency, in ONE round trip for the whole broadcast ──────────────
    // This was one awaited INSERT per recipient: 400 families meant 400
    // sequential round trips before a single message went out. The unique
    // constraint on (camp_id, source, source_id) does the same job in a single
    // statement — `ignoreDuplicates` skips the ones already marked, and the
    // returned rows are exactly the recipients this invocation has claimed.
    //
    // Two recipients can share an address (siblings on one parent email), so
    // the rows are deduped by source_id first. That matches the old behaviour
    // exactly: the second INSERT used to conflict and the recipient was
    // treated as already sent.
    const sourceIdOf = (r: any) => `${eventKey}:${r.email || r.phone || ""}`;
    let queue = consented;
    if (eventKey) {
      const bySource = new Map<string, any>();
      for (const r of consented) {
        const sid = sourceIdOf(r);
        if (!bySource.has(sid)) bySource.set(sid, r);
      }
      const rows = [...bySource.keys()].map((sid) => ({
        camp_id: campId, source: "broadcast_fallback", source_id: sid,
        title: subject || "", body: body,
      }));
      const { data: claimed, error: claimErr } = await supabase
        .from("notifications")
        .upsert(rows, { onConflict: "camp_id,source,source_id", ignoreDuplicates: true })
        .select("source_id");
      if (claimErr) {
        // Can't tell who has already been sent to. Sending anyway risks
        // double-messaging every family; refusing costs one retry. Refuse.
        console.error("[send-broadcast] idempotency claim failed:", claimErr.message);
        return json({ error: "Could not reserve this send — nothing was sent. Try again." }, 503);
      }
      const fresh = new Set((claimed || []).map((r: any) => r.source_id));
      queue = [...bySource.values()].filter((r) => fresh.has(sourceIdOf(r)));
    }

    // ── Send, paced and in parallel, within a wall-clock budget ─────────────
    const emailGate = rateGate(EMAIL_PER_SEC);
    const smsGate = rateGate(SMS_PER_SEC);
    const startedAt = Date.now();
    let outOfTime = false;
    const deferred: any[] = [];   // claimed but never attempted — must be released

    await pool(queue, CONCURRENCY, async (recipient) => {
      if (outOfTime) { deferred.push(recipient); return; }
      if (Date.now() - startedAt > BUDGET_MS) { outOfTime = true; deferred.push(recipient); return; }

      // Per-recipient subject/body (merge-tag-personalized by the composer)
      // override the shared top-level ones when present.
      const rSubject = recipient.subject || subject;
      const rBody = recipient.body || body;
      let anySent = false, anyFailed = false;

      if (sendEmail && recipient.email) {
        if (unsubscribedEmails.has(String(recipient.email).toLowerCase())) { results.emailSkipped++; }
        else {
          const link = await unsubLink(recipient.email);
          const htmlBody = buildBrandedEmailHtml({ subject: rSubject, body: rBody, branding: brandingResolved, campName, unsubLink: link, campAddress });
          const r = await withRetry(async () => {
            await emailGate();
            try {
              const { error } = await resend.emails.send({
                from: FROM_EMAIL, to: [recipient.email],
                subject: rSubject || `Message from ${campName || "Camp"}`, html: htmlBody,
                replyTo: campReplyTo,
                headers: link ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
              });
              if (!error) return { ok: true };
              const msg = (error as any).message || (error as any).name || "send failed";
              return { ok: false, error: msg, retryable: isRetryable((error as any).statusCode, msg) };
            } catch (e) {
              const msg = (e as Error).message;
              return { ok: false, error: msg, retryable: isRetryable(undefined, msg) };
            }
          });
          if (r.ok) { results.emailSent++; anySent = true; }
          else { results.emailFailed++; anyFailed = true; }
        }
      }

      if (sendSms && recipient.phone) {
        const smsTo = normalizePhone(recipient.phone);
        const key = smsTo ? phoneKey(smsTo) : null;
        if (!smsTo || !key || !phoneBook?.has(key)) { results.smsFailed++; anyFailed = true; }
        else if (optedOutPhones.has(key)) { results.smsSkipped++; }
        else {
          const smsBody = (rSubject ? rSubject + "\n\n" : "") + rBody + "\n\n— " + (campName || "Camp") + "\nReply STOP to opt out.";
          const r = await withRetry(async () => { await smsGate(); return await sendTelnyxSMS(smsTo, smsBody, campTelnyxNumber); });
          if (r.ok) { results.smsSent++; anySent = true; }
          else { results.smsFailed++; anyFailed = true; }
        }
      }

      // Nothing reached this family and the marker says it did. Release it, or
      // a retry of the broadcast skips them for ever: the marker is written
      // BEFORE the send (so a crash can never double-message anyone), which
      // means a failed send has to undo it or the failure is permanent. Only
      // when nothing at all got through — a family that got the email but not
      // the SMS has been reached, and re-sending would message them twice.
      if (anyFailed && !anySent) deferred.push(recipient);
    });

    // Release every claim we could not honour — the ones we ran out of time for
    // and the ones that failed outright — so the next invocation picks them up.
    if (eventKey && deferred.length) {
      const sids = [...new Set(deferred.map(sourceIdOf))];
      const { error: relErr } = await supabase
        .from("notifications")
        .delete()
        .eq("camp_id", campId).eq("source", "broadcast_fallback")
        .in("source_id", sids);
      if (relErr) console.error("[send-broadcast] could not release claims:", relErr.message);
    }

    const remaining = deferred.length;
    const done = !outOfTime;
    console.log(`[send-broadcast] Results:`, results,
      done ? `(complete, ${remaining} to retry)` : `(budget reached, ${remaining} not attempted)`);
    // `done:false` means the platform's clock, not a failure: the claims for
    // everyone unsent have been released, so calling again with the same
    // eventKey and the same list resumes exactly where this left off.
    return json({ success: true, ...results, done, remaining, attempted: queue.length - remaining });
  } catch (err) {
    console.error("[send-broadcast] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
