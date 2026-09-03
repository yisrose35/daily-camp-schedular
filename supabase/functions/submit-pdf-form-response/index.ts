// =============================================================================
// submit-pdf-form-response — receives a parent's filled-and-flattened PDF
// (produced client-side by pdf-lib: values stamped in, signature drawn as an
// image, form flattened) and records the submission the same way every other
// Link form response is recorded.
//
// Why a dedicated function rather than a straight client upload: the parent
// portal has no direct write access to the camp-pdf-forms bucket (migration
// 110 grants INSERT to staff only) or to link_form_responses (no INSERT/
// UPDATE policy at all — writes only ever go through the
// submit_link_form_response RPC). This function does the Storage upload with
// the service-role key after re-deriving the caller's real session and camper
// ownership, then calls the SAME submit_link_form_response RPC the plain
// digital-form path already uses (as the caller's own JWT, since that RPC is
// SECURITY DEFINER and derives everything from auth.uid() itself) — so
// badge/submission-tracking logic downstream needs zero changes.
//
// Request:  { campId, formId, formName, camperName, camperId?,
//             division?, grade?, bunk?, pdfBase64 }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { success: true, id } | { error }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "camp-pdf-forms";
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB decoded — generous for a stamped/flattened form PDF

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const { campId, formId, formName, camperName, camperId, division, grade, bunk, pdfBase64 } = await req.json();
    if (!campId || !formId || !camperName || !pdfBase64) {
      return json({ error: "campId, formId, camperName and pdfBase64 are required" }, 400);
    }

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user?.id) return json({ error: "unauthorized" }, 401);

    // Never trust the client's claim that this camper is theirs.
    const { data: owns, error: ownErr } = await asUser.rpc("verify_my_camper", { p_camp_id: campId, p_camper_name: camperName });
    if (ownErr) throw new Error(ownErr.message);
    if (!owns) return json({ error: `"${camperName}" isn't linked to your account for this camp.` }, 403);

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(pdfBase64);
    } catch {
      return json({ error: "pdfBase64 is not valid base64" }, 400);
    }
    if (bytes.length > MAX_PDF_BYTES) return json({ error: "PDF is too large" }, 400);
    // %PDF magic bytes — a cheap sanity check that this is actually a PDF,
    // not an arbitrary file smuggled through the base64 field.
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    if (header !== "%PDF-") return json({ error: "File does not look like a PDF" }, 400);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const path = `${campId}/submissions/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await service.storage.from(BUCKET).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) throw new Error(upErr.message);

    // Reuses the exact same RPC the plain digital-form path already calls —
    // this call runs as the caller's own JWT (SECURITY DEFINER, derives the
    // invite from auth.uid() itself), so badge/submission-tracking logic
    // downstream needs zero changes.
    const { data: subRes, error: subErr } = await asUser.rpc("submit_link_form_response", {
      p_form_id: String(formId),
      p_form_name: String(formName || ""),
      p_mode: "digital",
      p_camper_name: String(camperName),
      p_camper_id: camperId != null ? String(camperId) : null,
      p_answers: {},
      p_signature: null,
      p_file_name: null,
      p_file_data: null,
      p_division: division || null,
      p_grade: grade || null,
      p_bunk: bunk || null,
      p_camp_id: String(campId),
      p_filled_pdf_path: path,
    });
    if (subErr) throw new Error(subErr.message);
    if (!subRes?.success) return json({ error: subRes?.error || "submission_failed" }, 400);

    return json({ success: true, id: subRes.id });
  } catch (err) {
    console.error("[submit-pdf-form-response] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
