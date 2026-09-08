// =============================================================================
// payments-refund — BYOP dispatcher: refund a previous charge through
// whichever processor the caller's camp has connected.
//
// Same auth model as payments-charge (see that file's header) — the acting
// camp is always derived from the caller's own authenticated session, never
// from a client-supplied campId, so there is no way to refund against a
// different camp's processor connection than the one the caller actually
// belongs to.
//
// Request:  { externalTransactionId, amount? }
//           header: Authorization: Bearer <caller's Supabase access token>
//           (amount omitted = full refund of whatever was charged; the
//           adapter interface always takes an explicit amountCents, so a
//           full refund here means the CALLER must pass the original
//           charge amount — unlike Stripe's refund endpoint, this dispatcher
//           has no way to look up "the original amount" itself without a
//           processor-specific query call, which not every adapter may
//           support. Flagged in BYOP_SETUP.md as a known rough edge to
//           smooth out once a second adapter exists to compare against.)
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
    if (!campId) return json({ error: "Only camp owners/admins can issue a refund." }, 403);

    const { externalTransactionId, amount } = await req.json();
    if (!externalTransactionId || !amount) {
      return json({ error: "externalTransactionId and amount are required (see this file's header re: full refunds)." }, 400);
    }

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: camp } = await service.from("camps").select("payment_processor_key").eq("id", campId).maybeSingle();
    const processorKey = camp?.payment_processor_key;
    if (!processorKey || processorKey === "stripe") {
      return json({ error: "This camp is on Stripe — use stripe-refund instead." }, 400);
    }

    const adapter = getAdapter(processorKey);
    if (!adapter) return json({ error: `No adapter implemented for processor '${processorKey}'` }, 500);

    const { data: credResult } = await service.rpc("_admin_get_processor_credential", { p_camp_id: campId });
    if (!credResult?.success) return json({ error: credResult?.error || "This camp's processor isn't connected/verified yet." }, 400);

    const amountCents = Math.round(Number(amount) * 100);
    const result = await adapter.refund(credResult.credentials, String(externalTransactionId), amountCents);

    if (!result.success) {
      return json({ error: result.error || "Refund failed", status: result.status }, 200);
    }

    await service.rpc("record_processor_transaction", {
      p_camp_id: campId,
      p_processor_key: processorKey,
      p_external_transaction_id: result.externalTransactionId,
      p_kind: "refund",
      p_amount_cents: amountCents,
      p_status: result.status || "unknown",
      p_raw_response: result.raw ? JSON.parse(JSON.stringify(result.raw)) : null,
    });

    console.log(`[payments-refund] ${processorKey} refund ${result.externalTransactionId}: ${result.status} — $${amount} (camp ${campId})`);

    return json({ externalTransactionId: result.externalTransactionId, status: result.status, amount });
  } catch (err) {
    console.error("[payments-refund] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
