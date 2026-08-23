// =============================================================================
// telnyx-charge-monthly-fees — recurring monthly charge for a camp's own
// SMS number + 10DLC campaign.
//
// Meant to run daily via pg_cron (only actually charges rows whose
// next_charge_at is due today or earlier). Modeled directly on
// charge-due-installments/index.ts's scan-and-off-session-charge shape —
// same pattern, different table/recipient.
//
// A failed charge is recorded but does NOT suspend the number in this pass
// (see the plan's Deferred section) — it's flagged for the office to
// resolve, not auto-cut-off.
//
// Auth: x-cron-secret header, same convention as charge-due-installments.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const CRON_SECRET = Deno.env.get("TELNYX_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function stripeCharge(customerId: string, pmId: string | null, amountCents: number, description: string, metadata: Record<string, string>) {
  const params: Record<string, string> = {
    amount: String(amountCents),
    currency: "usd",
    customer: customerId,
    off_session: "true",
    confirm: "true",
    description,
  };
  if (pmId) params.payment_method = pmId;
  Object.entries(metadata).forEach(([k, v]) => { params[`metadata[${k}]`] = String(v); });
  const resp = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return resp.json();
}

function todayISO() { return new Date().toISOString().split("T")[0]; }
function addOneMonth(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().split("T")[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!STRIPE_SECRET) return json({ error: "Stripe not configured" }, 500);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = todayISO();
  let charged = 0, failed = 0;
  const details: Record<string, unknown>[] = [];

  const { data: due, error } = await supabase
    .from("camp_telnyx_provisioning")
    .select("camp_id, stripe_customer_id, stripe_payment_method_id, monthly_fee_cents, next_charge_at, business_legal_name")
    .eq("status", "active")
    .lte("next_charge_at", today)
    .limit(200);
  if (error) return json({ error: error.message }, 500);
  if (!due || due.length === 0) return json({ charged: 0, failed: 0 });

  for (const row of due) {
    if (!row.stripe_customer_id || !row.monthly_fee_cents) continue;
    const pi = await stripeCharge(
      row.stripe_customer_id, row.stripe_payment_method_id || null, row.monthly_fee_cents,
      `Campistry SMS number — monthly (${row.business_legal_name || row.camp_id})`,
      { campId: row.camp_id, purpose: "telnyx_monthly_fee" },
    );

    if (pi.error || pi.status !== "succeeded") {
      failed++;
      await supabase.from("camp_telnyx_provisioning").update({
        error_message: pi.error?.message || `Monthly charge ${pi.status || "failed"} — number stays active, please update the card on file.`,
        updated_at: new Date().toISOString(),
      }).eq("camp_id", row.camp_id);
      details.push({ camp: row.camp_id, result: "failed", reason: pi.error?.message || pi.status });
    } else {
      charged++;
      await supabase.from("camp_telnyx_provisioning").update({
        last_charged_at: new Date().toISOString(),
        next_charge_at: addOneMonth(row.next_charge_at),
        error_message: null,
        updated_at: new Date().toISOString(),
      }).eq("camp_id", row.camp_id);
      details.push({ camp: row.camp_id, result: "charged" });
    }
  }

  console.log(`[telnyx-charge-monthly-fees] charged ${charged}, failed ${failed}`);
  return json({ charged, failed, details });
});
