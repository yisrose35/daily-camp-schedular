// =================================================================
// cloud_storage_bridge.js — Campistry Canonical Cloud State Engine
// PRODUCTION SaaS MODE — Cloud is source of truth
// =================================================================
(function () {
  'use strict';

  console.log("☁️ Campistry Cloud Bridge Active");

  const TABLE = "camp_state";
  const LOCAL_CACHE_KEY = "CAMPISTRY_LOCAL_CACHE";
  const CAMP_ID = "fc00ba21-bfb0-4c34-b084-2471bd77d8f9";   // your real camp
  const SCHEMA_VERSION = 1;

  // ------------------------------------------------------------
  // Resolve active user
  // ------------------------------------------------------------
  async function getUser() {
    const { data } = await window.supabase.auth.getUser();
    return data?.user || null;
  }

  // ------------------------------------------------------------
  // Load canonical state from cloud
  // ------------------------------------------------------------
  async function loadCloudState() {
    const { data, error } = await window.supabase
      .from(TABLE)
      .select("state")
      .eq("camp_id", CAMP_ID)
      .single();

    if (error || !data) return null;
    return data.state || null;
  }

  // ------------------------------------------------------------
  // Save canonical state to cloud
  // ------------------------------------------------------------
  async function saveCloudState(state) {
    const user = await getUser();
    if (!user) return;

    state.schema_version = SCHEMA_VERSION;
    state.updated_at = new Date().toISOString();

    await window.supabase.from(TABLE).upsert({
      camp_id: CAMP_ID,
      owner_id: user.id,
      state
    });
  }

  // ------------------------------------------------------------
  // PUBLIC API — Cloud-authoritative, overwrite-proof
  // ------------------------------------------------------------
  Object.defineProperty(window, "loadGlobalSettings", {
    configurable: false,
    writable: false,
    value: async function () {
      const cloud = await loadCloudState();
      if (cloud) {
        localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cloud));
        return cloud;
      }
      return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
    }
  });

  Object.defineProperty(window, "saveGlobalSettings", {
    configurable: false,
    writable: false,
    value: async function (k, v) {
      const state = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
      state[k] = v;
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
      await saveCloudState(state);
    }
  });

})();
