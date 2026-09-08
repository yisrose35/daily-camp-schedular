// =============================================================================
// payments-charge — BYOP dispatcher: charge a family's saved payment method
// through whichever processor the caller's camp has connected.
//
// Mirrors stripe-charge's auth model exactly (same reasoning, same
// callerCampId derivation — never trust a client-supplied campId to decide
// where the charge runs or which credentials get used). The one thing this
// function does NOT do is decide "should this camp even be calling me" —
// that's the client's job (campistry_me.js checks the camp's
// payment_processor_key and only calls this function for a non-Stripe camp;
// Stripe camps keep calling stripe-charge directly, completely unchanged).
// If a Stripe camp ends up here anyway, this function safely no-ops with a
// clear error rather than trying to do anything Stripe-specific — 'stripe'
// is deliberately not one of the adapters this function knows how to load.
//
// Request:  { customerRef, amount, description?, metadata? }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { externalTransactionId, status, amount } or { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAdapter } from "./_shared/processor_adapter.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SENDER_ROLES = ["owner", "admin"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Identical shape to stripe-charge's own callerCampId — kept as its own
// copy rather than imported, matching this repo's established convention
// for per-function auth helpers (only the processor-plugin CONTRACT itself,
// in _shared/processor_adapter.ts, is a deliberate exception to that).
async function callerCampId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await asUser.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;

  const { data: ownedCamps } = await asUser.from("camps").select("id").eq("owner", uid);
  const owned = Array.isArray(ownedCamps) && ownedCamps.length
    ? (ownedCamps.find((c: { id: string }) => c.id === uid) || ownedCamps[0])
    : null;
  if (owned?.id) return owned.id;

  const { data: memberships } = await asUser
    .from("camp_users")
    .select("camp_id, role")
    .eq("user_id", uid)
    .not("accepted_at", "is", null)
    .order("accepted_at", { ascending: false })
    .limit(1);
  const membership = Array.isArray(memberships) && memberships.length ? memberships[0] : null;
  if (membership?.camp_id && SENDER_ROLES.includes(membership.role)) return membership.camp_id;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const campId = await callerCampId(req);
    if (!campId) return json({ error: "Only camp owners/admins can charge a stored payment method." }, 403);

    const { customerRef, amount, description } = await req.json();
    if (!customerRef || !amount) return json({ error: "customerRef and amount required" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-charge instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    const amountCents = Math.round(Number(amount) * 100);
    const result = await adapter.charge(credResult.credentials, amountCents, String(customerRef), description || "Campistry payment");

    if (!result.success) {
      return json({ error: result.error || "Charge declined", status: result.status }, 200);
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_external_transaction_id: result.externalTransactionId,
      p_kind: "charge",
      p_amount_cents: amountCents,
      p_status: result.status || "unknown",
      p_raw_response: result.raw ? JSON.parse(JSON.stringify(result.raw)) : null,
    });

    console.log(`[payments-charge] ${processorKey} charge ${result.externalTransactionId}: ${result.status} — $${amount} (camp ${campId})`);

    return json({ externalTransactionId: result.externalTransactionId, status: result.status, amount });
  } catch (err) {
    console.error("[payments-charge] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
