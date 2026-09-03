// =============================================================================
// get-pdf-form-urls — the only way to actually fetch PDF Forms bytes.
//
// Templates and filled submissions live in the private `camp-pdf-forms`
// Storage bucket (migration 110) with NO direct client read access — every
// read goes through this function, which mints a short-lived signed URL
// after re-deriving authorization server-side (never trusting the caller's
// claim). Modeled directly on get-photo-urls.
//
// Two kinds, since PDF form templates aren't table rows (they live in the
// linkForms.digital[] JSON blob) while submissions are (link_form_responses,
// migration 013):
//   - kind: 'template'   — { campId, path } — any staff member OR any
//     invited parent of that camp may view any of that camp's PDF form
//     templates (same visibility as the form's name/description already has
//     via get_link_camp_forms). Checked via can_access_pdf_form_template
//     (migration 111).
//   - kind: 'submission' — { responseId } — staff-only, for the office
//     "Download filled PDF" action. Checked via get_pdf_form_response_path
//     (migration 111), which also resolves the actual Storage path so this
//     function never has to trust a client-supplied path for submissions.
//
// Auth: requires the caller's real Supabase session JWT — no anon-key-only
// path, same reasoning as get-photo-urls.
//
// Request:  { kind: 'template', campId: string, path: string }
//        or { kind: 'submission', responseId: string }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { url: string | null }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — regenerated on every open, never persisted
const BUCKET = "camp-pdf-forms";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { kind, campId, path, responseId } = await req.json();

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user?.id) return json({ error: "unauthorized" }, 401);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let storagePath: string | null = null;
    let download = false;

    if (kind === "template") {
      if (!campId || !path || typeof path !== "string") return json({ error: "campId and path are required" }, 400);
      // Guard the path stays scoped to this camp's own templates folder —
      // defense in depth on top of the RPC's own authorization check.
      if (!path.startsWith(`${campId}/templates/`)) return json({ url: null });
      const { data: allowed, error: rpcErr } = await asUser.rpc("can_access_pdf_form_template", { p_camp_id: campId });
      if (rpcErr) throw new Error(rpcErr.message);
      if (allowed) storagePath = path;
    } else if (kind === "submission") {
      if (!responseId) return json({ error: "responseId is required" }, 400);
      const { data: resolvedPath, error: rpcErr } = await asUser.rpc("get_pdf_form_response_path", { p_response_id: responseId });
      if (rpcErr) throw new Error(rpcErr.message);
      if (resolvedPath) { storagePath = resolvedPath; download = true; }
    } else {
      return json({ error: "kind must be 'template' or 'submission'" }, 400);
    }

    if (!storagePath) return json({ url: null });

    const { data: signed, error: signErr } = await service.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, download ? { download: true } : undefined);
    if (signErr) throw new Error(signErr.message);

    return json({ url: signed?.signedUrl || null });
  } catch (err) {
    console.error("[get-pdf-form-urls] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
