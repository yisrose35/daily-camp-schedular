// =============================================================================
// send-scheduled-reports — scans every camp's saved custom reports for ones
// with a due delivery schedule (weekly/monthly) and emails the configured
// recipients a "your report is ready" notification via send-broadcast.
//
// Meant to be called on an interval by pg_cron (see SCHEDULED_REPORTS_SETUP.md).
// Mirrors check-notes-reminders: same camp_state_kv scan pattern, same
// x-cron-secret gate. Scope is deliberately a notification email only — it
// does NOT regenerate the report server-side or attach a CSV; the recipient
// opens Campistry Me to see the live report. Replicating the client-side
// report builder / filter engine in Deno would duplicate significant logic
// for marginal gain.
//
// Idempotency: there's no shared table with a unique constraint to dedupe
// against here (a saved report only exists inside its camp's `campistryMe`
// camp_state_kv blob), so this function stamps `lastSentAt` directly onto
// the report object and writes the `campistryMe` value back for that camp
// after sending — the next scan's date-math naturally skips it until the
// next cadence is due.
//
// Auth: requires header  x-cron-secret: <SCHEDULED_REPORTS_CRON_SECRET>.
// Response: { ok, sent, scannedCamps, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("SCHEDULED_REPORTS_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const DAY_MS = 24 * 60 * 60 * 1000;
// "Monthly" is approximated as 28 days rather than calendar-month math —
// same spirit as check-notes-reminders' own documented timezone shortcut:
// good enough for a first cut, exact calendar alignment is a follow-up.
const FREQ_INTERVAL_DAYS: Record<string, number> = { weekly: 7, monthly: 28 };

interface ReportSchedule { freq?: string; recipients?: string; lastSentAt?: string; }
interface SavedReport { id?: string; name?: string; schedule?: ReportSchedule | null; }

function isDue(sch: ReportSchedule, now: Date): boolean {
  const days = FREQ_INTERVAL_DAYS[sch.freq || ""];
  if (!days) return false;
  if (!sch.lastSentAt) return true;
  const last = new Date(sch.lastSentAt).getTime();
  if (isNaN(last)) return true;
  return now.getTime() - last >= days * DAY_MS;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Gate: only the scheduler (holding the secret) may run this.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now = new Date();
  let sent = 0;
  let scannedCamps = 0;
  const details: Record<string, unknown>[] = [];

  const { data: rows, error } = await supabase.from("camp_state_kv")
    .select("camp_id, value").eq("key", "campistryMe");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const row of (rows || [])) {
    scannedCamps++;
    const store = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    const reports: SavedReport[] = Array.isArray(store?.savedReports) ? store!.savedReports : [];
    if (!reports.length) continue;

    const due = reports.filter((r) =>
      r.schedule && r.schedule.freq && r.schedule.freq !== "off" && isDue(r.schedule, now)
    );
    if (!due.length) continue;

    // Camp display name for the email header — best effort, falls back gracefully.
    // camp_id here may be the camp's own id or its owner id (multi-scheduler
    // camps share one `camps` row keyed by owner) — same lookup campistry_lite.js uses.
    let campName = "Camp";
    try {
      const { data: campRow } = await supabase.from("camps").select("name")
        .or(`id.eq.${row.camp_id},owner.eq.${row.camp_id}`).limit(1).maybeSingle();
      if (campRow?.name) campName = campRow.name;
    } catch (_) { /* non-fatal — email still sends with the generic fallback */ }

    for (const rep of due) {
      const emails = (rep.schedule!.recipients || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      if (!emails.length) continue;

      const subject = `Your scheduled report is ready: ${rep.name || "Report"}`;
      const body = `Your report "${rep.name || "Report"}" is ready. Open Campistry Me and go to Reports to view the latest data.`;

      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-broadcast`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` },
          body: JSON.stringify({
            to: emails.map((email) => ({ email })),
            subject, body, method: "email", campName,
          }),
        });
        if (!resp.ok) {
          details.push({ camp: row.camp_id, report: rep.id, error: `send-broadcast ${resp.status}` });
          continue;
        }
      } catch (e) {
        details.push({ camp: row.camp_id, report: rep.id, error: String(e) });
        continue;
      }

      rep.schedule!.lastSentAt = now.toISOString();
      sent++;
      details.push({ camp: row.camp_id, report: rep.id, recipients: emails.length });
    }

    // Re-fetch immediately before writing to shrink the read-modify-write race
    // window — an office save of an unrelated campistryMe field mid-scan could
    // otherwise be reverted by writing back the stale snapshot from the top of
    // this loop. Not eliminated (no JSON-patch primitive here), but narrowed
    // from "the whole scan" down to "this camp's processing time."
    const { data: freshRow, error: freshErr } = await supabase.from("camp_state_kv")
      .select("value").eq("camp_id", row.camp_id).eq("key", "campistryMe").maybeSingle();
    const freshStore = (freshErr || !freshRow?.value || typeof freshRow.value !== "object")
      ? store : freshRow.value as Record<string, any>;
    const { error: updErr } = await supabase.from("camp_state_kv")
      .update({ value: { ...freshStore, savedReports: reports } })
      .eq("camp_id", row.camp_id).eq("key", "campistryMe");
    if (updErr) details.push({ camp: row.camp_id, error: `write-back failed: ${updErr.message}` });
  }

  console.log(`[scheduled-reports] scanned ${scannedCamps} camps, ${sent} reports sent`);
  return new Response(
    JSON.stringify({ ok: true, sent, scannedCamps, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
