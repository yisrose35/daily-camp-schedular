// =============================================================================
// stripe-setup — RETIRED (TED-061).
//
// This used to create Stripe customers and card-setup intents for anyone who
// called it, with no login check. Nothing in Campistry calls it any more: cards
// are saved through stripe-setup-checkout (parents) and the office's card-setup
// links. It now refuses every request.
//
// If it is still deployed: Supabase Dashboard → Edge Functions → stripe-setup →
// either delete it, or deploy this file over it.
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(JSON.stringify({ error: "This function is retired. Use the card-setup link instead." }), {
    status: 410,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
