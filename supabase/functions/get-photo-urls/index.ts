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
// Preview URLs by default. Pass resolution:'original' to request the
// full-resolution file instead (Phase 3, migration 081) — staff always get
// it (they uploaded it, no purchase needed), a parent only gets it for a
// photo they've actually bought an HD unlock for
// (get_viewable_original_photo_ids, vs. get_viewable_photo_ids for
// previews). Never mixed in one call — the whole batch is one resolution.
//
// Request:  { photoIds: string[], resolution?: 'preview' | 'original' }
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

    const { photoIds, resolution } = await req.json();
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return json({ error: "photoIds must be a non-empty array" }, 400);
    }
    if (photoIds.length > MAX_IDS) {
      return json({ error: `Too many photoIds (max ${MAX_IDS})` }, 400);
    }
    const wantOriginal = resolution === "original";
    const pathColumn = wantOriginal ? "original_path" : "preview_path";

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    if (!userData?.user?.id) return json({ error: "unauthorized" }, 401);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const pathById: Record<string, string> = {};

    // Layer 1: staff access, enforced by link_photos' own RLS (lp_staff_all)
    // via the caller's own JWT-scoped client — only rows they're really
    // staff of come back. Staff always get whichever resolution they asked
    // for, no purchase check — they uploaded it.
    const { data: staffRows } = await asUser
      .from("link_photos")
      .select(`id, ${pathColumn}`)
      .in("id", photoIds);
    const staffAuthorizedIds = new Set<string>();
    for (const row of (staffRows || []) as Record<string, any>[]) {
      staffAuthorizedIds.add(row.id);
      if (row[pathColumn]) pathById[row.id] = row[pathColumn];
    }

    // Layer 2: whatever wasn't already authorized as staff — check the
    // parent path in one batched call. Previews use get_viewable_photo_ids
    // (ownership + tag review only); originals ADD an HD-purchase check via
    // get_viewable_original_photo_ids (migration 081) — this is the only
    // place the purchase gate actually applies.
    const remainingIds = photoIds.filter((id: string) => !staffAuthorizedIds.has(id));
    const parentAuthorizedIds = new Set<string>();
    if (remainingIds.length > 0) {
      const rpcName = wantOriginal ? "get_viewable_original_photo_ids" : "get_viewable_photo_ids";
      const { data: viewableIds } = await asUser.rpc(rpcName, { p_photo_ids: remainingIds });
      for (const id of viewableIds || []) parentAuthorizedIds.add(id);
      if (parentAuthorizedIds.size > 0) {
        // Service-role fetch for the path column — safe here because
        // authorization was already established above; this call itself
        // bypasses RLS deliberately (parents have no direct grant on
        // link_photos), matching this session's established pattern.
        const { data: parentRows } = await service
          .from("link_photos")
          .select(`id, ${pathColumn}`)
          .in("id", Array.from(parentAuthorizedIds));
        for (const row of (parentRows || []) as Record<string, any>[]) {
          if (row[pathColumn]) pathById[row.id] = row[pathColumn];
        }
      }
    }

    const authorizedIds = Object.keys(pathById);
    const urls: Record<string, string | null> = {};
    for (const id of photoIds) urls[id] = null; // default: unauthorized or no file at this resolution yet

    if (authorizedIds.length > 0) {
      const paths = authorizedIds.map((id) => pathById[id]);
      // Originals get download:true (Content-Disposition: attachment) — a
      // paid HD unlock should actually save the file, not just display it
      // inline the same way a free preview does.
      const { data: signed, error: signErr } = await service.storage
        .from("camp-photos")
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS, wantOriginal ? { download: true } : undefined);
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
