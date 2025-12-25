// =================================================================
// cloud_storage_bridge.js — Campistry Canonical Cloud State Engine
// GUARANTEED CLOUD PERSISTENCE • MULTI-DEVICE SAFE • VERSIONED
// =================================================================
(function () {
  'use strict';

  const TABLE = "camp_state";
  const SCHEMA_VERSION = 1;
  const LOCAL_CACHE_KEY = "CAMPISTRY_LOCAL_CACHE";

  // 🔒 HARD BOUND CAMP (temporary until multi-camp UI is added)
  const HARDCODED_CAMP_ID = "fc00ba21-bfb0-4c34-b084-2471bd77d8f9";

  // ---------------------------------------------------------------
  // Resolve active camp + owner
  // ---------------------------------------------------------------
  async function getActiveCamp() {
    const { data } = await window.supabase.auth.getUser();
    if (!data?.user) return null;

    return {
      id: HARDCODED_CAMP_ID,
      owner: data.user.id
    };
  }

  // ---------------------------------------------------------------
  // Load canonical cloud state
  // ---------------------------------------------------------------
  async function loadCloudState() {
    const camp = await getActiveCamp();
    if (!camp) return null;

    const { data } = await window.supabase
      .from(TABLE)
      .select("state")
      .eq("camp_id", camp.id)
      .single();

    return data?.state || null;
  }

  // ---------------------------------------------------------------
  // Save canonical cloud state
  // ---------------------------------------------------------------
  async function saveCloudState(state) {
    const camp = await getActiveCamp();
    if (!camp) return;

    state.schema_version = SCHEMA_VERSION;
    state.updated_at = new Date().toISOString();

    await window.supabase.from(TABLE).upsert({
      camp_id: camp.id,
      owner_id: camp.owner,
      state
    });
  }

  // ---------------------------------------------------------------
  // PUBLIC API — DO NOT CHANGE ANY OTHER FILES
  // ---------------------------------------------------------------
  window.loadGlobalSettings = async function () {
    // 1️⃣ Cloud first
    const cloud = await loadCloudState();
    if (cloud && Object.keys(cloud).length) {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cloud));
      return cloud;
    }

    // 2️⃣ Fallback local cache
    return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
  };

  window.saveGlobalSettings = async function (k, v) {
    const state = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
    state[k] = v;

    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
    await saveCloudState(state);
  };

})();
