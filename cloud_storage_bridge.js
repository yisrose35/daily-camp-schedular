// =================================================================
// cloud_storage_bridge.js — Campistry Canonical Cloud State Engine
// DIAGNOSTIC MODE — exposes Supabase write errors
// =================================================================
console.log("CLOUD BRIDGE LOADING...");

(function () {
  'use strict';

  const TABLE = "camp_state";
  const SCHEMA_VERSION = 1;
  const LOCAL_CACHE_KEY = "CAMPISTRY_LOCAL_CACHE";

  // 🔒 Hard-bound camp
  const HARDCODED_CAMP_ID = "fc00ba21-bfb0-4c34-b084-2471bd77d8f9";

  async function getActiveCamp() {
    const { data } = await window.supabase.auth.getUser();
    console.log("AUTH USER:", data?.user);
    if (!data?.user) return null;

    return {
      id: HARDCODED_CAMP_ID,
      owner: data.user.id
    };
  }

  async function loadCloudState() {
    const camp = await getActiveCamp();
    if (!camp) return null;

    const { data, error } = await window.supabase
      .from(TABLE)
      .select("state")
      .eq("camp_id", camp.id)
      .single();

    console.log("CLOUD LOAD:", data, error);
    return data?.state || null;
  }

  async function saveCloudState(state) {
    const camp = await getActiveCamp();
    console.log("CAMP CONTEXT:", camp);

    state.schema_version = SCHEMA_VERSION;
    state.updated_at = new Date().toISOString();

    const { data, error } = await window.supabase.from(TABLE).upsert({
      camp_id: camp.id,
      owner_id: camp.owner,
      state
    });

    console.log("SUPABASE WRITE RESULT:", data, error);
  }

  window.loadGlobalSettings = async function () {
    const cloud = await loadCloudState();
    if (cloud && Object.keys(cloud).length) {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cloud));
      return cloud;
    }
    return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
  };

  window.saveGlobalSettings = async function (k, v) {
    const state = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
    state[k] = v;

    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
    await saveCloudState(state);
  };

})();
