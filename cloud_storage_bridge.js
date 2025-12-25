// =================================================================
// cloud_storage_bridge.js — Forces ALL Campistry storage into Supabase
// FIXED: Uses User ID as the storage key so data follows the user
// =================================================================
(function () {
  'use strict';

  const TABLE = "campistry_kv";   // single-row key/value store

  // 1. Helper to get the current user's unique ID
  async function getUserKey() {
    const { data } = await window.supabase.auth.getUser();
    if (data && data.user) {
        return data.user.id; // Returns something like "a1b2-c3d4-..."
    }
    return "anon_backup"; // Fallback if something goes wrong
  }

  async function load(key) {
    const { data, error } = await window.supabase
      .from(TABLE)
      .select("value")
      .eq("key", key)
      .single();

    if (error || !data) return null;
    return data.value;
  }

  async function save(key, value) {
    await window.supabase
      .from(TABLE)
      .upsert({ key, value });
  }

  // --- NEW ASYNC FUNCTIONS ---

  window.loadGlobalSettings = async function () {
    // ASK: Who is logged in?
    const key = await getUserKey();
    console.log("☁️ Loading data for user:", key);
    
    // FETCH: Get that user's specific data
    return (await load(key)) || {};
  };

  window.saveGlobalSettings = async function (k, v) {
    const key = await getUserKey();
    
    // 1. Load current full blob for this user
    const g = (await load(key)) || {};
    
    // 2. Update just the specific part (e.g., 'app1')
    g[k] = v;
    
    // 3. Save it back to this user's row
    await save(key, g);
  };
})();
