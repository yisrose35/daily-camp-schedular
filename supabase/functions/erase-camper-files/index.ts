// =============================================================================
// erase-camper-files — deletes the stored files of campers who were erased.
//
// erase_camper (migration 254) removes every row tied to a camper's number,
// but SQL cannot delete from Storage. It queues the camper's stored files
// (filled PDF forms in camp-pdf-forms) in camp_erased_files, and this function
// deletes them. The Me page calls it right after an erase.
//
// Only files the database queued are ever deleted. The caller names a camp,
// never a path, so nothing a browser sends can point this at another file.
//
// Auth: the caller's Supabase session; they must be the camp's owner or admin.
//
// Request:  { campId }   header: Authorization: Bearer <access token>
// Response: { success, deleted, failed }
// =============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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
    const { campId } = await req.json();
    if (!campId || typeof campId !== "string") return json({ error: "campId is required" }, 400);

    const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await asUser.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ error: "unauthorized" }, 401);

    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: isAdmin, error: adminErr } = await service.rpc("is_camp_admin", { p_camp_id: campId, p_user_id: uid });
    if (adminErr) throw new Error(adminErr.message);
    if (isAdmin !== true) return json({ error: "forbidden" }, 403);

    const { data: queued, error: takeErr } = await service.rpc("take_erased_files", { p_camp_id: campId });
    if (takeErr) throw new Error(takeErr.message);
    const files: { bucket: string; path: string }[] = queued?.files || [];

    // Only this camp's own folder, whatever the queue says.
    const byBucket = new Map<string, string[]>();
    for (const f of files) {
      if (!f?.bucket || !f?.path || !String(f.path).startsWith(`${campId}/`)) continue;
      const list = byBucket.get(f.bucket) || [];
      list.push(String(f.path));
      byBucket.set(f.bucket, list);
    }

    let deleted = 0;
    const failed: { bucket: string; path: string }[] = [];
    for (const [bucket, paths] of byBucket) {
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const { error } = await service.storage.from(bucket).remove(chunk);
        if (error) chunk.forEach((path) => failed.push({ bucket, path }));
        else deleted += chunk.length;
      }
    }

    // Anything Storage refused goes back on the queue for the next call.
    if (failed.length) {
      await service.from("camp_erased_files").insert(failed.map((f) => ({ camp_id: campId, bucket: f.bucket, path: f.path })));
    }
    return json({ success: failed.length === 0, deleted, failed: failed.length });
  } catch (err) {
    return json({ error: (err as Error).message || "failed" }, 500);
  }
});
