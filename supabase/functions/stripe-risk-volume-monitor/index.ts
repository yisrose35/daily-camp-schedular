// =============================================================================
// stripe-risk-volume-monitor — daily proactive check for unusual volume spikes
// on Campistry's own PLATFORM Stripe account.
//
// WHY THIS EXISTS: every camp's charge is ultimately a destination charge on
// Campistry's own platform Stripe account — camps only ever RECEIVE a
// transfer (see stripe-connect-onboard-camp's header comment). That means
// Stripe's PayFac/rolling-reserve risk from a sudden, unpredictable volume
// spike (e.g. many camps' registration windows opening at once) is
// concentrated on the PLATFORM account, aggregated across every camp — not
// on any individual camp. Per Stripe's own guidance, the mitigation for a
// KNOWN spike is to notice it fast and get ahead of it (contact Stripe
// support proactively) rather than let their automated risk systems flag it
// cold. This function is the "notice it fast" half — stripe-webhook's
// handleRiskEvent() is the reactive half (Radar/review/dispute/payout
// events), this is the proactive half (a volume trend Stripe hasn't
// flagged yet, but which looks like exactly the kind of jump their own
// docs warn triggers a reserve).
//
// Meant to be called once a day by pg_cron (mirrors charge-due-installments'
// x-cron-secret pattern exactly — see BILLING_PAYMENTS_SETUP.md). Compares
// yesterday's total successful charge volume on the platform account against
// the trailing 7-day average of the days before that. Emails
// campistryoffice@gmail.com (via Resend, same convention as
// stripe-webhook's risk alerts) only when the numbers actually look like a
// spike — this is meant to be quiet on ordinary days, not a daily digest.
//
// Two independent trigger conditions (either fires an alert):
//   (a) RATIO spike  — yesterday's volume >= SPIKE_MULTIPLIER x the trailing
//       baseline average, and the baseline is large enough for a ratio to be
//       meaningful (a jump from $10 to $40 isn't a real signal).
//   (b) ABSOLUTE spike — yesterday's volume alone crosses a fixed high-water
//       mark, regardless of baseline. Catches the case a ratio can't (e.g.
//       very early in the platform's life, baseline is near $0, so ANY ratio
//       looks infinite/meaningless) — a real, large first-time volume day
//       still deserves a heads-up.
//
// Response: { ok, dateChecked, yesterdayCents, baselineAvgCents,
//             baselineDays, spike, reason, alertSent }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_API = "https://api.stripe.com/v1";
const CRON_SECRET = Deno.env.get("RISK_MONITOR_CRON_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RISK_ALERT_EMAIL = "campistryoffice@gmail.com";

const resend = new Resend(RESEND_API_KEY);

// How many completed days of history to use as the "normal" baseline —
// the 7 days immediately before yesterday, so weekday/weekend mix evens out
// over a week rather than comparing to a single arbitrary day.
const BASELINE_DAYS = 7;

// A jump needs to clear BOTH "big relative to normal" and "big in absolute
// terms" to fire the ratio trigger — keeps a quiet week (baseline near $0)
// from flagging a completely ordinary day at, say, $80 as a "spike."
const SPIKE_MULTIPLIER = 2.5;
const MIN_BASELINE_CENTS_FOR_RATIO = 10000; // $100 — below this, ratios are noise

// Fires regardless of baseline — for a real, large volume day even when
// there's little/no prior history to compare against.
const ABSOLUTE_SPIKE_CENTS = 500000; // $5,000/day placeholder — bump as the platform grows

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function startOfUTCDay(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

// Sums successful charge volume (gross, not net-of-refund — a refund
// doesn't undo the risk signal of the original charge volume) for
// [gteSec, ltSec) on the PLATFORM account, paginating through Stripe's
// charges list. A camp scheduling app's charge volume is modest enough
// that this is a handful of pages at most per day, even during a
// registration-window spike — that's exactly the scenario this exists to
// catch, so it needs to hold up under that load, not just the quiet case.
async function sumChargesInRange(gteSec: number, ltSec: number): Promise<{ totalCents: number; count: number }> {
  let totalCents = 0;
  let count = 0;
  let startingAfter: string | null = null;

  for (let page = 0; page < 50; page++) { // hard cap — never loop forever on a Stripe API hiccup
    const params = new URLSearchParams({
      "created[gte]": String(gteSec),
      "created[lt]": String(ltSec),
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);

    const resp = await fetch(`${STRIPE_API}/charges?${params.toString()}`, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
    });
    const page_ = await resp.json();
    if (page_.error) throw new Error(page_.error.message);

    const items: Record<string, any>[] = page_.data || [];
    for (const ch of items) {
      if (ch.status === "succeeded") {
        totalCents += ch.amount || 0;
        count++;
      }
    }
    if (!page_.has_more || items.length === 0) break;
    startingAfter = items[items.length - 1].id;
  }

  return { totalCents, count };
}

async function sendVolumeSpikeAlert(details: {
  dateChecked: string;
  yesterdayCents: number;
  baselineAvgCents: number;
  baselineDays: number;
  reason: string;
}) {
  if (!RESEND_API_KEY) {
    console.error("[stripe-risk-volume-monitor] RESEND_API_KEY not configured — cannot send spike alert");
    return false;
  }
  const fmt = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#B91C1C;">Unusual Stripe charge volume detected</h2>
      <p>${details.reason}</p>
      <p><strong>Volume on ${details.dateChecked}:</strong> ${fmt(details.yesterdayCents)}</p>
      <p><strong>Trailing ${details.baselineDays}-day average:</strong> ${fmt(details.baselineAvgCents)}</p>
      <p style="margin-top:20px;color:#64748B;font-size:13px;">
        This is total charge volume across the PLATFORM Stripe account (every
        camp's charges combined) — not any single camp. A sudden, unpredictable
        jump like this is exactly what can trigger Stripe's automated risk
        review or a rolling reserve on the account, even for fully legitimate
        volume. Per Stripe's own guidance, proactively reaching out to Stripe
        support with the expected volume (e.g. "several camps' registration
        windows opened this week") before they flag it themselves is the best
        way to keep this from turning into a delayed payout.
      </p>
    </div>`;
  try {
    const { error } = await resend.emails.send({
      from: "Campistry Platform Alerts <onboarding@resend.dev>",
      to: [RISK_ALERT_EMAIL],
      subject: `Stripe alert: unusual charge volume on ${details.dateChecked}`,
      html,
    });
    if (error) { console.error(`[stripe-risk-volume-monitor] alert email failed: ${JSON.stringify(error)}`); return false; }
    return true;
  } catch (e) {
    console.error(`[stripe-risk-volume-monitor] alert email threw: ${(e as Error).message}`);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Same gate as charge-due-installments — only the scheduler (holding the
  // secret) may run this.
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!STRIPE_SECRET) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const now = new Date();
    const todayStart = startOfUTCDay(now);
    const yesterdayStart = todayStart - 86400;
    const baselineStart = yesterdayStart - BASELINE_DAYS * 86400;

    const [yesterday, baseline] = await Promise.all([
      sumChargesInRange(yesterdayStart, todayStart),
      sumChargesInRange(baselineStart, yesterdayStart),
    ]);

    const baselineAvgCents = Math.round(baseline.totalCents / BASELINE_DAYS);
    const dateChecked = new Date(yesterdayStart * 1000).toISOString().split("T")[0];

    let spike = false;
    let reason = "";

    if (yesterday.totalCents >= ABSOLUTE_SPIKE_CENTS) {
      spike = true;
      reason = `Charge volume crossed the $${(ABSOLUTE_SPIKE_CENTS / 100).toLocaleString()} single-day mark.`;
    } else if (
      baselineAvgCents >= MIN_BASELINE_CENTS_FOR_RATIO &&
      yesterday.totalCents >= baselineAvgCents * SPIKE_MULTIPLIER
    ) {
      spike = true;
      const ratio = (yesterday.totalCents / baselineAvgCents).toFixed(1);
      reason = `Charge volume was ${ratio}x the trailing ${BASELINE_DAYS}-day average.`;
    }

    console.log(`[stripe-risk-volume-monitor] ${dateChecked}: $${yesterday.totalCents / 100} (${yesterday.count} charges) vs baseline avg $${baselineAvgCents / 100}/day — spike=${spike}`);

    let alertSent = false;
    if (spike) {
      alertSent = await sendVolumeSpikeAlert({
        dateChecked,
        yesterdayCents: yesterday.totalCents,
        baselineAvgCents,
        baselineDays: BASELINE_DAYS,
        reason,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      dateChecked,
      yesterdayCents: yesterday.totalCents,
      yesterdayChargeCount: yesterday.count,
      baselineAvgCents,
      baselineDays: BASELINE_DAYS,
      spike,
      reason: spike ? reason : null,
      alertSent,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[stripe-risk-volume-monitor] Error:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
