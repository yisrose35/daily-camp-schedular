// =============================================================================
// get-photo-urls — the only way to actually see a Link Photos gallery image.
//
// Photos live in the private `camp-photos` Storage bucket (migration
// 080_photo_storage.sql) with NO direct client read access at all — every
// view goes through this function, which mints short-lived signed URLs
// after re-deriving authorization itself, never trusting the caller's claim
// that they're allowed to see a given photo id.
//
// Auth: requires the caller's real Supabase session JWT (parent OR staff —
// this endpoint serves both the parent gallery and the staff review-queue
// UI). No anon-key-only path exists here, unlike stripe-checkout's known
// residual gap — there's no legitimate reason for this one to be public.
//
// Authorization, per requested photo id:
//   1. Staff check first (cheap, single batched query): does RLS on
//      link_photos (lp_staff_all — owner/camp_users of that photo's own
//      camp) let the caller's own JWT-scoped client read the row at all?
//      If yes, authorized, and the row already carries preview_path.
//   2. Whatever's left goes through get_viewable_photo_ids (migration 080)
//      — the same _parent_owns_camper + pending=false logic
//      get_my_camper_photos already uses, batched into one round trip.
//
// PREVIEW URLs ONLY in this phase — original_path is never requested or
// signed here. That gate belongs to Phase 3 (paid full-resolution
// unlocks), which doesn't exist yet; until it does, nothing in this
// codebase can ever retrieve an original-resolution photo, which is the
// correct, safe default.
//
// Request:  { photoIds: string[] }
//           header: Authorization: Bearer <caller's Supabase access token>
// Response: { urls: { [photoId]: string | null } }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — regenerated on every gallery load, never persisted
const MAX_IDS = 200; // a very large gallery page — guards against an unbounded batch

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

    const { photoIds } = await req.json();
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return json({ error: "photoIds must be a non-empty array" }, 400);
    }
    if (photoIds.length > MAX_IDS) {
      return json({ error: `Too many photoIds (max ${MAX_IDS})` }, 400);
    }

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user?.id) return json({ error: "unauthorized" }, 401);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const previewPathById: Record<string, string> = {};

    // Layer 1: staff access, enforced by link_photos' own RLS (lp_staff_all)
    // via the caller's own JWT-scoped client — only rows they're really
    // staff of come back.
    const { data: staffRows } = await asUser
      .from("link_photos")
      .select("id, preview_path")
      .in("id", photoIds);
    const staffAuthorizedIds = new Set<string>();
    for (const row of staffRows || []) {
      staffAuthorizedIds.add(row.id);
      if (row.preview_path) previewPathById[row.id] = row.preview_path;
    }

    // Layer 2: whatever wasn't already authorized as staff — check the
    // parent path in one batched call.
    const remainingIds = photoIds.filter((id: string) => !staffAuthorizedIds.has(id));
    const parentAuthorizedIds = new Set<string>();
    if (remainingIds.length > 0) {
      const { data: viewableIds } = await asUser.rpc("get_viewable_photo_ids", { p_photo_ids: remainingIds });
      for (const id of viewableIds || []) parentAuthorizedIds.add(id);
      if (parentAuthorizedIds.size > 0) {
        // Service-role fetch for preview_path — safe here because
        // authorization was already established above; this call itself
        // bypasses RLS deliberately (parents have no direct grant on
        // link_photos), matching this session's established pattern.
        const { data: parentRows } = await service
          .from("link_photos")
          .select("id, preview_path")
          .in("id", Array.from(parentAuthorizedIds));
        for (const row of parentRows || []) {
          if (row.preview_path) previewPathById[row.id] = row.preview_path;
        }
      }
    }

    const authorizedIds = Object.keys(previewPathById);
    const urls: Record<string, string | null> = {};
    for (const id of photoIds) urls[id] = null; // default: unauthorized or no preview yet

    if (authorizedIds.length > 0) {
      const paths = authorizedIds.map((id) => previewPathById[id]);
      const { data: signed, error: signErr } = await service.storage
        .from("camp-photos")
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
      if (signErr) throw new Error(signErr.message);
      // createSignedUrls preserves input order — zip back up by index.
      authorizedIds.forEach((id, i) => {
        const entry = signed?.[i];
        if (entry && !entry.error && entry.signedUrl) urls[id] = entry.signedUrl;
      });
    }

    return json({ urls });
  } catch (err) {
    console.error("[get-photo-urls] Error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
