// ============================================================================
// deposit-inbox — turn a bank's deposit alert email into a tuition payment.
//
// Zelle has no merchant API and a plain ACH credit has no callback, so the
// fastest thing that can tell Campistry money arrived is the alert email the
// camp's own bank sends the moment it lands. The camp points that alert at
//
//     deposits+<inbound_token>@<the inbound domain>
//
// Resend receives it and POSTs an `email.received` webhook here. This function
// verifies it, parses it, decides which family it belongs to, and either posts
// it to that family's ledger or drops it in the reconcile inbox for a human.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS ENDPOINT CREATES MONEY. It is public (Resend is not a Supabase caller),
// so it is authenticated by THREE independent checks, all required:
//
//   1. Svix signature over the RAW body — proves Resend sent it.
//   2. The routing token in the To: address — proves which camp, and is a
//      per-camp secret that can be rotated without touching DNS.
//   3. The From: domain against the camp's allowlist — proves the camp's BANK
//      sent it, not somebody who learned the address.
//
// Anyone who can forge a deposit here can make a family's balance disappear.
// Never relax these to "make testing easier"; use a test camp instead.
// ─────────────────────────────────────────────────────────────────────────────
//
// Always answers 200 once the signature passes, including on parse failures.
// A non-2xx makes Resend redeliver, and a redelivered deposit is a duplicate
// deposit; the fingerprint would catch it, but a webhook that is loudly
// "failing" while behaving correctly wastes far more time than a logged skip.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_WEBHOOK_SECRET,
//      RESEND_API_KEY, (optional) RESEND_RECEIVING_URL
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS NOT DEPLOYED DIRECTLY. It is the authored half of
// supabase/functions/deposit-inbox/index.ts, which tools/build_deposit_inbox.js
// generates by prepending the parser and matcher to it.
//
// Why: Supabase's Dashboard deploy flattens a function to source/index.ts, so a
// relative import of a sibling module ("../_shared/…") resolves outside the
// bundle and the deploy fails with "Module not found". Campistry deploys from
// the Dashboard (no CLI), so the deployable artifact has to be ONE file with no
// local imports. `Parser` and `Matcher` below are provided by the generator.
//
// Edit this file (or the two root modules), then run:
//     node tools/build_deposit_inbox.js
// ─────────────────────────────────────────────────────────────────────────────
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supplied by tools/build_deposit_inbox.js, which inlines campistry_deposit_parser.js
// and campistry_deposit_match.js above this point and binds them off globalThis.
declare const Parser: any;
declare const Matcher: any;
declare const Template: any;

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
// the `whsec_` prefix. The signature header may carry several space-separated
// `v1,<sig>` values (during a secret rotation), so any one matching is a pass.
async function verifySvix(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    // Refuse rather than accept an unverifiable webhook — the same stance
    // telnyx-sms-webhook takes when TELNYX_PUBLIC_KEY is missing.
    console.error("[deposit-inbox] RESEND_WEBHOOK_SECRET is not set — refusing");
    return false;
  }
  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const sigHeader = req.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  // Replay window. Without this, a captured delivery can be replayed forever.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 300) {
    console.warn("[deposit-inbox] timestamp outside the 5-minute window");
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
    console.error("[deposit-inbox] signature verify failed", (e as Error).message);
    return false;
  }
}

// ── 2. reading the webhook payload ───────────────────────────────────────────
// Resend's `email.received` payload carries METADATA ONLY — the body and any
// attachments are fetched separately (that is what lets it handle large mail in
// serverless environments). The exact field names are not fully documented
// publicly, so every lookup below accepts a few plausible spellings and the
// setup guide has a step for confirming the real shape against one live
// delivery. If a future payload includes the body inline, we use it and skip
// the extra fetch entirely.
function pick(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function addressesOf(v: unknown): string[] {
  // to/from arrive as a string, an array of strings, or objects with .address
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const a = o.address ?? o.email ?? o.value;
      if (typeof a === "string") return [a];
    }
    return [];
  });
}

/** `deposits+ab12cd@inbound.example.com` -> `ab12cd` */
function tokenFromAddresses(addrs: string[]): string {
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/\+([a-z0-9]{8,64})@/);
    if (m) return m[1];
  }
  // Also allow the whole local part to be the token (`ab12cd@...`), which is
  // what a Resend managed address looks like when there is no plus-addressing.
  for (const a of addrs) {
    const m = String(a).toLowerCase().match(/^([a-z0-9]{16,64})@/);
    if (m) return m[1];
  }
  return "";
}

function domainOf(addr: string): string {
  const m = String(addr).toLowerCase().match(/@([^>\s]+)$/);
  return m ? m[1] : "";
}

/**
 * Read the deposit again with a learned template, where one exists.
 *
 * Precedence is deliberate: the camp's own template beats a shared one. The
 * camp that owns the mailbox is the authority on what its own mail looks like,
 * and a shared template is only ever a good guess made by other people.
 *
 * A value is taken from the template ONLY when it is plausible for its field.
 * When the two rules inside a template disagree, the value is dropped rather
 * than picked between, and the disagreement is counted — that is the earliest
 * signal a bank has changed its layout, and it is far better to fall back to
 * the generic parser for one email than to post a confidently wrong payer.
 */
async function applyLearnedTemplate(
  service: any,
  campId: string,
  fromAddress: string,
  body: string,
  deposit: Record<string, unknown>,
): Promise<{ used: boolean; outcome: string; signature: string } | null> {
  const signature = Template.signature(fromAddress);
  if (!signature || !body) return null;

  const { data, error } = await service.rpc("get_bank_templates", { p_camp_id: campId });
  if (error || !data?.success) return null;

  const rows = (data.templates || []).filter((t: any) => t.bank_signature === signature);
  // Own template first; shared only as a fallback.
  const row = rows.find((t: any) => t.scope === "camp") || rows.find((t: any) => t.scope === "shared");
  if (!row?.template) return null;

  const read = Template.read(row.template, body);
  const fields = Object.keys(read);
  if (!fields.length) return { used: false, outcome: "miss", signature };

  let applied = 0;
  let conflicted = false;

  for (const field of fields) {
    const r = read[field];
    if (r.byAnchor && r.byLine && !r.agree) { conflicted = true; continue; }
    if (!r.value || !Template.plausible(field, r.value)) continue;

    if (field === "amount") {
      const v = Parser.parseAmount(r.value);
      // A template pointed at the wrong number is the one case here that could
      // move money, so the amount is the one field checked against the prose
      // reading as well: they must agree, or the parser's value stands.
      if (v && Math.abs(v - Number(deposit.amount || 0)) < 0.005) applied++;
      continue;
    }
    if (field === "payerName" && r.value !== deposit.payerName) {
      deposit.payerName = r.value;
      applied++;
    }
    if (field === "memo" && r.value !== deposit.memo) {
      deposit.memo = r.value;
      deposit.memoCode = Parser.parseMemoCode(r.value) || deposit.memoCode || "";
      applied++;
    }
  }

  const outcome = conflicted ? "conflict" : (applied ? "hit" : "miss");
  await service.rpc("_bank_template_result", {
    p_camp_id: campId,
    p_bank_signature: signature,
    p_outcome: outcome,
  }).catch(() => {});

  return { used: applied > 0, outcome, signature };
}

/** Fetch the message body Resend held back from the webhook payload. */
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
      console.warn(`[deposit-inbox] body fetch ${res.status} for ${emailId}`);
      return { text: "", html: "" };
    }
    const body = await res.json();
    const d = (body?.data ?? body) as Record<string, unknown>;
    return { text: pick(d, "text", "plain", "textBody"), html: pick(d, "html", "htmlBody") };
  } catch (e) {
    console.error("[deposit-inbox] body fetch failed", (e as Error).message);
    return { text: "", html: "" };
  }
}

// ── 3. matching context ──────────────────────────────────────────────────────
// Families come from the campistryMe blob (read-only — this function never
// writes to camp_state_kv; see migration 145's header for why). Balances come
// from the snapshot the browser publishes, because buildFamilyLedgers() cannot
// run here. A missing snapshot just means the overpay guardrail sits out.
async function loadContext(service: ReturnType<typeof createClient>, campId: string) {
  const [kv, aliasRes, balRes] = await Promise.all([
    service.from("camp_state_kv").select("value")
      .eq("camp_id", campId).eq("key", "campistryMe").maybeSingle(),
    service.from("payer_aliases")
      .select("family_key, normalized, handle, display_name, kind").eq("camp_id", campId),
    service.from("family_balance_snapshots")
      .select("family_key, balance_cents").eq("camp_id", campId),
  ]);

  const families = (kv.data?.value as Record<string, unknown>)?.families ?? {};

  const aliases = (aliasRes.data ?? []).map((a: Record<string, unknown>) => ({
    familyKey: a.family_key,
    normalized: a.normalized,
    handle: a.handle,
    displayName: a.display_name,
    kind: a.kind,
  }));

  const ledgers: Record<string, { balance: number }> = {};
  for (const b of balRes.data ?? []) {
    ledgers[(b as Record<string, unknown>).family_key as string] = {
      balance: ((b as Record<string, unknown>).balance_cents as number) / 100,
    };
  }

  return { families, aliases, ledgers };
}

// ── handler ──────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();

  // Check 1 of 3 — and the only one that returns non-200, because an unsigned
  // request is not a delivery worth acknowledging.
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
  const toAddrs = [...addressesOf(data.to), ...addressesOf(data.recipient), ...addressesOf(data.envelope_to)];
  const fromAddrs = [...addressesOf(data.from), ...addressesOf(data.sender)];
  const subject = pick(data, "subject");
  const emailId = pick(data, "email_id", "emailId", "id");

  // Check 2 of 3 — which camp is this for?
  const token = tokenFromAddresses(toAddrs);
  if (!token) {
    console.warn("[deposit-inbox] no routing token in", JSON.stringify(toAddrs));
    return json({ ok: true, skipped: "no_routing_token" });
  }

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: camp, error: campErr } = await service.rpc("_deposit_camp_for_token", {
    p_token: token,
  });
  if (campErr || !camp?.success) {
    console.warn("[deposit-inbox] unknown or disabled token");
    return json({ ok: true, skipped: "unknown_token" });
  }
  const campId = camp.campId as string;

  // Check 3 of 3 — did the camp's actual bank send this?
  const allowlist: string[] = (camp.senderAllowlist ?? []).map((s: string) => s.toLowerCase());
  if (allowlist.length) {
    const senderDomains = fromAddrs.map(domainOf).filter(Boolean);
    const ok = senderDomains.some((d) =>
      allowlist.some((allowed) => d === allowed || d.endsWith(`.${allowed}`))
    );
    if (!ok) {
      console.warn(`[deposit-inbox] sender ${senderDomains.join(",")} not allowed for camp ${campId}`);
      return json({ ok: true, skipped: "sender_not_allowed" });
    }
  }

  // Body: inline if the payload ever carries it, otherwise fetched.
  let text = pick(data, "text", "plain");
  let html = pick(data, "html");
  if (!text && !html) {
    const fetched = await fetchBody(emailId);
    text = fetched.text;
    html = fetched.html;
  }

  const parsed = Parser.parseEmail({
    subject,
    text,
    html,
    receivedAt: pick(data, "created_at", "createdAt", "received_at") || new Date().toISOString(),
  });

  // ── learned layout ─────────────────────────────────────────────────────────
  //
  // If this camp (or enough other camps) have taught us this bank's alert
  // layout, those rules beat reading the prose. The generic parser stays in
  // charge of everything a template does not cover -- direction, the deposit
  // kind, the trace number, and any field the template has lost -- so a
  // template is an improvement on the answer, never a replacement for the
  // pipeline.
  const bodyForTemplate = text || Parser.htmlToText(html || "");
  const templateOutcome = parsed.ok
    ? await applyLearnedTemplate(service, campId, fromAddrs[0] || "", bodyForTemplate, parsed.deposit)
    : null;

  if (!parsed.ok) {
    // Two very different failures hide behind "could not parse", and treating
    // them the same is how money goes missing.
    //
    //  * outbound_payment / non_event / no_amount -- we RECOGNISED the message
    //    and it is not income: a payment we sent, a money request, a decline,
    //    a marketing blast. Dropping these is correct; most mail reaching this
    //    address is exactly this, and storing it would bury the real items.
    //
    //  * unclear_direction WITH an amount -- we recognised nothing at all, yet
    //    the message talks about money. On a bank whose wording we have never
    //    seen, that is indistinguishable from a genuine deposit. This used to
    //    be dropped too, which meant a real deposit from an unfamiliar bank
    //    vanished leaving only a log line that ages out in days, and nobody
    //    found out until a family said they had paid.
    //
    // So the ambiguous ones are recorded as 'unparsed': never counted in any
    // balance, always visible in the inbox, with the message text attached so
    // the office can read what actually arrived and fix it by hand.
    const keepForHuman = parsed.reason === "unclear_direction" && !!parsed.amount;
    if (!keepForHuman) {
      console.log(`[deposit-inbox] camp ${campId}: skipped (${parsed.reason}) "${subject}"`);
      return json({ ok: true, skipped: parsed.reason });
    }

    const bodyText = (text || Parser.htmlToText(html || "")).slice(0, 4000);
    const unparsed = await service.rpc("_deposit_record_unparsed", {
      p_camp_id: campId,
      // No parsed fields to fingerprint on, so the message itself is the
      // identity. That still collapses a Resend retry of the same email onto
      // one row, which is what this needs to do.
      p_fingerprint: "raw_" + Parser.fingerprint({
        date: pick(data, "created_at", "createdAt", "received_at").slice(0, 10),
        amount: parsed.amount || 0,
        payerName: subject,
        traceId: emailId || bodyText.slice(0, 120),
      }),
      p_raw_subject: subject,
      p_raw_excerpt: bodyText,
      p_reason: parsed.reason,
    });

    if (unparsed.error) {
      // Same reasoning as a failed record below: the money may be real and we
      // could not store it, so let Resend retry.
      console.error("[deposit-inbox] unparsed record failed", unparsed.error.message);
      return json({ error: "record_failed" }, 500);
    }

    console.log(
      `[deposit-inbox] camp ${campId}: UNPARSED ($${parsed.amount}) kept for review "${subject}"`,
    );
    return json({ ok: true, unparsed: true, duplicate: unparsed.data?.duplicate ?? false });
  }

  const deposit = parsed.deposit;
  // Kept on the row so a payer name read off unfamiliar prose can be checked
  // against what actually arrived. Without it, "is this name right?" has no
  // answer anyone can look up.
  deposit.rawExcerpt = (text || Parser.htmlToText(html || "")).slice(0, 4000);
  const ctx = await loadContext(service, campId);
  const decision = Matcher.decide(deposit, ctx, {
    autoPostAt: camp.autoPostAt,
    suggestAt: camp.suggestAt,
    ambiguousGap: camp.ambiguousGap,
    dryRun: camp.dryRun,
  });

  const record = await service.rpc("_deposit_record", {
    p_camp_id: campId,
    p_fingerprint: Parser.fingerprint(deposit),
    p_amount_cents: Math.round(deposit.amount * 100),
    p_deposit: deposit,
    p_decision: {
      decision: decision.decision,
      familyKey: decision.familyKey,
      confidence: decision.confidence,
      guardrail: decision.guardrail,
      candidates: decision.candidates,
      reasons: decision.candidates?.[0]?.reasons ?? [],
    },
  });

  if (record.error) {
    // The one case worth a 5xx: the money is real, we could not store it, and
    // a Resend retry is exactly what we want.
    console.error("[deposit-inbox] record failed", record.error.message);
    return json({ error: "record_failed" }, 500);
  }

  console.log(
    `[deposit-inbox] camp ${campId}: $${deposit.amount} from "${deposit.payerName}" ` +
    `-> ${record.data?.duplicate ? "duplicate" : decision.decision}` +
    (decision.guardrail ? ` (${decision.guardrail})` : "") +
    (templateOutcome ? ` [template ${templateOutcome.signature}: ${templateOutcome.outcome}]` : ""),
  );

  return json({
    ok: true,
    duplicate: record.data?.duplicate ?? false,
    decision: decision.decision,
    confidence: decision.confidence,
  });
});
