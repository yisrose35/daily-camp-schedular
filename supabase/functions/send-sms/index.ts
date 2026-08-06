// ============================================================================
// send-sms — Campistry Lite daily activity texts
//
// Sends SMS messages via the Twilio REST API. Called from campistry_lite.js
// ("Messaging" tab) with window.supabase.functions.invoke('send-sms', ...).
//
// Payload:  { messages: [ { to: "+15551234567", body: "..." }, ... ] }
// Response: { sent: n, failed: n, results: [ { to, ok, sid?|error? } ] }
//
// Secrets (set with `supabase secrets set`):
//   TWILIO_ACCOUNT_SID   — Twilio account SID
//   TWILIO_AUTH_TOKEN    — Twilio auth token
//   TWILIO_FROM_NUMBER   — E.164 sending number (or Messaging Service SID
//                          via TWILIO_MESSAGING_SERVICE_SID)
//
// Security: the function runs with JWT verification (Supabase default), and
// additionally re-checks the CALLER's camp role server-side via the
// get_user_role() RPC — only owner/admin/scheduler may send. Counselors and
// viewers get 403. The Twilio credentials never reach the browser.
//
// It ALSO checks every recipient against the caller's own camp. Checking the
// sender's role but not the destination meant an admin could text any number
// on earth on the camp's Twilio account — a billing and abuse hole, and the
// reason "Link only works inside the camp" was not actually true. Numbers are
// gathered from the camp's own records (camper parents, staff, families) using
// the CALLER'S JWT, so RLS still decides what they can see; anything not on
// that list is refused and reported, never silently dropped.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BATCH = 200;          // hard cap per invocation
const SENDER_ROLES = ["owner", "admin", "scheduler"];

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Re-verify the caller's camp role using their own JWT (RLS-equivalent check).
async function callerRole(req: Request): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authHeader) return null;

  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_role`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) return null;
  const role = await res.json();
  return typeof role === "string" ? role : null;
}

// Every phone number that belongs to this camp: parent numbers on campers,
// staff numbers in the bunk directory, and family/household contacts.
// Returns a Set of comparison keys (see phoneKey) or null if the lookup
// failed — null means "couldn't verify", and we refuse rather than guess.
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

  const book = new Set<string>();
  const add = (v: unknown) => { const k = phoneKey(v); if (k) book.add(k); };

  // Camper records: parent and emergency numbers.
  const roster = byKey.app1?.camperRoster || {};
  Object.values<any>(roster).forEach((c) => {
    add(c?.parent1Phone); add(c?.parent2Phone);
    add(c?.emergencyPhone); add(c?.summerPhone);
  });

  const me = byKey.campistryMe || {};
  // Staff directory.
  Object.values<any>(me.bunkStaff || {}).forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((s: any) => add(s?.phone));
  });
  // Families / households.
  Object.values<any>(me.families || {}).forEach((f) => {
    (f?.households || []).forEach((hh: any) => {
      (hh?.parents || []).forEach((par: any) => add(par?.phone));
    });
  });

  return book;
}

// Comparison key: last 10 digits. Forgiving about +1, spaces, dashes and
// parentheses, which is how the same number gets typed three different ways
// across a roster.
function phoneKey(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Very light E.164 sanity check — Twilio does the real validation.
function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;       // bare US number
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER");
    const messagingServiceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");

    if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
      return json(500, {
        error: "SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID) as Supabase secrets.",
      });
    }

    const role = await callerRole(req);
    if (!role || !SENDER_ROLES.includes(role)) {
      return json(403, { error: "Not authorized to send SMS (owner/admin/scheduler only)." });
    }

    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return json(400, { error: "Payload must be { messages: [{ to, body }, ...] }" });
    }
    if (messages.length > MAX_BATCH) {
      return json(400, { error: `Too many messages in one batch (max ${MAX_BATCH}).` });
    }

    // Recipients must belong to this camp. Refusing to send is the safe
    // failure here: an unverifiable list is far more likely to be a bug or an
    // abuse attempt than a legitimate blast.
    const phoneBook = await campPhoneBook(req);
    if (!phoneBook) {
      return json(502, { error: "Could not verify recipients against your camp. Nothing was sent." });
    }

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basicAuth = "Basic " + btoa(`${accountSid}:${authToken}`);

    const results: Array<{ to: string; ok: boolean; sid?: string; error?: string }> = [];

    for (const msg of messages) {
      const to = normalizePhone(msg?.to);
      const body = String(msg?.body || "").slice(0, 1600); // Twilio max concat length
      if (!to || !body.trim()) {
        results.push({ to: String(msg?.to || ""), ok: false, error: "Invalid phone number or empty message" });
        continue;
      }

      const key = phoneKey(to);
      if (!key || !phoneBook.has(key)) {
        results.push({
          to,
          ok: false,
          error: "Not a number in this camp — Campistry only texts people on your roster or staff list.",
        });
        continue;
      }

      const form = new URLSearchParams({ To: to, Body: body });
      if (messagingServiceSid) {
        form.set("MessagingServiceSid", messagingServiceSid);
      } else {
        form.set("From", fromNumber!);
      }

      try {
        const res = await fetch(twilioUrl, {
          method: "POST",
          headers: {
            Authorization: basicAuth,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        });
        const data = await res.json();
        if (res.ok) {
          results.push({ to, ok: true, sid: data.sid });
        } else {
          results.push({ to, ok: false, error: data.message || `Twilio error ${res.status}` });
        }
      } catch (e) {
        results.push({ to, ok: false, error: (e as Error).message });
      }
    }

    const sent = results.filter((r) => r.ok).length;
    return json(200, { sent, failed: results.length - sent, results });
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
});
