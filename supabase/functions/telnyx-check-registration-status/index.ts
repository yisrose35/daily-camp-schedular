// =============================================================================
// telnyx-check-registration-status — polls Telnyx for 10DLC campaign
// approval and activates numbers once approved.
//
// Meant to run on a schedule (pg_cron, every few hours — see
// SMS_EMAIL_BROADCAST_SETUP.md). For every camp_telnyx_provisioning row at
// status='pending_carrier_review', checks the campaign's status with Telnyx.
// On approval: flips to 'active' AND writes the number into camps.
// telnyx_from_number (migration 075) — that's the only place
// send-broadcast/send-scheduled-broadcasts read from, so this is the whole
// integration point, no other code needs to change.
//
// Auth: x-cron-secret header, same convention as charge-due-installments /
// send-scheduled-broadcasts.
//
// IMPORTANT: the exact Telnyx campaign-status endpoint/response shape below
// is written from Telnyx's documented API shape but has not been exercised
// against a live account from this environment — verify against
// https://developers.telnyx.com/api/messaging/10dlc before relying on it.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_API = "https://api.telnyx.com/v2";
const CRON_SECRET = Deno.env.get("TELNYX_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!TELNYX_API_KEY) return json({ error: "Telnyx not configured" }, 500);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: pending, error } = await supabase
    .from("camp_telnyx_provisioning")
    .select("camp_id, telnyx_campaign_id, telnyx_phone_number")
    .eq("status", "pending_carrier_review")
    .limit(100);
  if (error) return json({ error: error.message }, 500);
  if (!pending || pending.length === 0) return json({ checked: 0, activated: 0, rejected: 0 });

  let activated = 0, rejected = 0;
  const details: Record<string, unknown>[] = [];

  for (const row of pending) {
    if (!row.telnyx_campaign_id) continue;
    try {
      const res = await fetch(`${TELNYX_API}/10dlc/campaign/${row.telnyx_campaign_id}`, {
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
      });
      const data = await res.json().catch(() => ({}));
      const campaignStatus = String(data?.data?.campaignStatus || data?.data?.status || "").toUpperCase();

      if (campaignStatus === "APPROVED" || campaignStatus === "ACTIVE") {
        await supabase.from("camp_telnyx_provisioning").update({
          status: "active", updated_at: new Date().toISOString(),
        }).eq("camp_id", row.camp_id);
        // The one place send-broadcast/send-scheduled-broadcasts actually
        // read from — this is what makes the new number take effect.
        await supabase.from("camps").update({
          telnyx_from_number: row.telnyx_phone_number,
        }).eq("id", row.camp_id);
        activated++;
        details.push({ camp: row.camp_id, result: "activated", phoneNumber: row.telnyx_phone_number });
      } else if (campaignStatus === "REJECTED" || campaignStatus === "FAILED" || campaignStatus === "DECLINED") {
        const reason = data?.data?.failureReasons?.join?.(", ") || data?.data?.reason || "Campaign rejected by carrier review.";
        await supabase.from("camp_telnyx_provisioning").update({
          status: "rejected", error_message: reason, updated_at: new Date().toISOString(),
        }).eq("camp_id", row.camp_id);
        rejected++;
        details.push({ camp: row.camp_id, result: "rejected", reason });
      }
      // Anything else (e.g. "TCR_PENDING", "PENDING") — still waiting, leave as-is.
    } catch (e) {
      console.error("[telnyx-check-registration-status] check failed", row.camp_id, (e as Error).message);
    }
  }

  console.log(`[telnyx-check-registration-status] checked ${pending.length}, activated ${activated}, rejected ${rejected}`);
  return json({ checked: pending.length, activated, rejected, details });
});
