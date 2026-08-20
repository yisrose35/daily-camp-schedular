// =============================================================================
// send-pickup-reminders — fires a high-priority push exactly 5 minutes before
// a confirmed early-pickup's scheduled time, to every resolved recipient
// (division head, bunk staff, league captains), regardless of whether they
// already acknowledged the original alert.
//
// Modeled on check-notes-reminders' pg_cron -> HTTP -> x-cron-secret pattern,
// but running every MINUTE, not every 5 — a 5-minutes-before reminder can't
// tolerate the wander a 5-minute cadence would introduce, and unlike that
// function's naive UTC string comparison, pickup_alerts.pickup_at is a real
// timestamptz already resolved against the camp's stored timezone (see
// migrations 063/065), so this comparison is actually correct, not "off by
// up to a few hours and accepted as good enough."
//
// Idempotency: an atomic UPDATE ... WHERE reminder_fired_at IS NULL ...
// RETURNING claims each alert exactly once — simpler than the generic
// notifications table's UNIQUE(camp_id,source,source_id)+upsert dance,
// because this table is single-purpose and "already reminded" is naturally
// just a column here.
//
// "Regardless of prior acknowledgment" governs the PUSH (sent to every
// recipient unconditionally) — an already-"Saw it" recipient's ack_state is
// left alone; only a SNOOZED recipient's snoozed_until is cleared, so the
// alert re-surfaces in their in-app list instead of staying hidden through
// the exact window it matters most.
//
// Auth: requires header  x-cron-secret: <PICKUP_REMINDER_CRON_SECRET>.
// Response: { ok, remindersSent, alertsChecked, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("PICKUP_REMINDER_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const details: Record<string, unknown>[] = [];
  let remindersSent = 0;

  // Atomic claim: only alerts within 5 minutes of pickup_at, not yet
  // reminded. The <= (not a tight equality band) intentionally mirrors
  // check-notes-reminders' own forgiving comparison — a delayed cron run
  // still catches anything that crossed the T-5 threshold since the last
  // run, rather than permanently missing it if this function is ever late.
  const cutoff = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data: due, error: claimErr } = await supabase
    .from("pickup_alerts")
    .update({ reminder_fired_at: new Date().toISOString() })
    .is("reminder_fired_at", null)
    .not("pickup_at", "is", null)
    .lte("pickup_at", cutoff)
    .select("id, camp_id, camper_name, camper_bunk, pickup_time, pickup_at");

  if (claimErr) {
    return new Response(JSON.stringify({ error: claimErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const alert of (due || [])) {
    const { data: recipients, error: recErr } = await supabase
      .from("pickup_alert_recipients")
      .select("id, recipient_email, ack_state")
      .eq("alert_id", alert.id)
      .neq("recipient_email", "");
    if (recErr || !recipients || !recipients.length) {
      details.push({ alertId: alert.id, camper: alert.camper_name, error: recErr?.message || "no_recipients" });
      continue;
    }

    // Re-surface for anyone who'd snoozed — the whole point of this reminder
    // is that snoozing does not excuse someone from the T-5 warning.
    const snoozedIds = recipients.filter((r) => r.ack_state === "snoozed").map((r) => r.id);
    if (snoozedIds.length) {
      await supabase.from("pickup_alert_recipients")
        .update({ ack_state: "unseen", snoozed_until: null })
        .in("id", snoozedIds);
    }

    const emails = recipients.map((r) => r.recipient_email).filter(Boolean);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          campId: alert.camp_id,
          pref: "pickupAlert",
          staffEmails: emails,
          title: `Pickup in 5 min — ${alert.camper_name}`,
          body: `Scheduled for ${alert.pickup_time}${alert.camper_bunk ? " · " + alert.camper_bunk : ""}`,
          data: { page: "campistry_lite.html", alertId: alert.id },
        }),
      });
      const sendResult = await res.json().catch(() => ({}));
      if (sendResult?.success) remindersSent += (sendResult.sent || 0);
      details.push({ alertId: alert.id, camper: alert.camper_name, recipients: emails.length, sendResult });
    } catch (e) {
      details.push({ alertId: alert.id, camper: alert.camper_name, error: String((e as Error)?.message || e) });
    }
  }

  console.log(`[pickup-reminders] checked ${(due || []).length} alerts, ${remindersSent} pushes sent`);
  return new Response(
    JSON.stringify({ ok: true, remindersSent, alertsChecked: (due || []).length, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
