// =============================================================================
// check-notes-reminders — scans every camp's Campistry Notes for reminders
// that have come due and inserts a row into `notifications` for each one.
//
// Meant to be called every few minutes by pg_cron (see NOTIFICATIONS_SETUP.md).
// A reminder isn't a database event — it becomes "due" purely because time
// passed — so unlike link_messages (which has an AFTER INSERT trigger) this
// has to be a scheduled scan instead.
//
// Idempotency: notifications has a UNIQUE(camp_id, source, source_id)
// constraint, so every insert here uses upsert(...).ignoreDuplicates — a
// reminder that's already been surfaced is silently skipped on the next
// scan. The Notes data itself (camp_state_kv key='campistry_notes_v1') is
// never written back to; nothing is mutated to mark "already notified".
//
// Known limitation: a reminder's `date`/`time` are stored as plain strings
// with no timezone (same as everywhere else reminder/due dates live in this
// app, e.g. installment dueDate). This function compares them against UTC
// "now", so a reminder can fire up to several hours early/late relative to
// the camp's local timezone. Acceptable for a first cut; tightening this
// would mean storing the camp's timezone somewhere and is a follow-up, not
// a blocker.
//
// Auth: requires header  x-cron-secret: <NOTES_REMINDER_CRON_SECRET>.
// Response: { ok, notified, scannedCamps, details[] }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("NOTES_REMINDER_CRON_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

interface NoteReminder { date?: string; time?: string; msg?: string; }
interface Note {
  id?: string; title?: string; body?: string; reminder?: NoteReminder | null;
  trashed?: boolean;
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
  let notified = 0;
  let scannedCamps = 0;
  const details: Record<string, unknown>[] = [];

  const { data: rows, error } = await supabase.from("camp_state_kv")
    .select("camp_id, value").eq("key", "campistry_notes_v1");
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const row of (rows || [])) {
    scannedCamps++;
    const store = (row.value && typeof row.value === "object") ? row.value as Record<string, any> : null;
    const notes: Note[] = Array.isArray(store?.notes) ? store!.notes : [];
    if (!notes.length) continue;

    const dueNotifications = [];
    for (const note of notes) {
      if (!note.id || note.trashed) continue;
      const r = note.reminder;
      if (!r || !r.date) continue;
      const dueAt = new Date(`${r.date}T${r.time || "00:00"}:00Z`);
      if (isNaN(dueAt.getTime()) || dueAt.getTime() > now.getTime()) continue;

      dueNotifications.push({
        camp_id: row.camp_id,
        source: "notes_reminder",
        source_id: note.id,
        title: r.msg || note.title || "Reminder",
        body: (note.body || "").slice(0, 140),
        link_target: "campistry_notes.html?note=" + note.id,
      });
    }
    if (!dueNotifications.length) continue;

    const { error: insErr } = await supabase.from("notifications")
      .upsert(dueNotifications, { onConflict: "camp_id,source,source_id", ignoreDuplicates: true });
    if (insErr) {
      details.push({ camp: row.camp_id, error: insErr.message });
      continue;
    }
    // Upper bound, not exact — duplicates the constraint silently skips are
    // counted here too, but this number is only for the response/log.
    notified += dueNotifications.length;
    details.push({ camp: row.camp_id, dueChecked: dueNotifications.length });
  }

  console.log(`[notes-reminders] scanned ${scannedCamps} camps, ${notified} new notifications`);
  return new Response(
    JSON.stringify({ ok: true, notified, scannedCamps, details }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
