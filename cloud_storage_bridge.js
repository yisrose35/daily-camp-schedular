// =================================================================
// cloud_storage_bridge.js — Campistry Cloud Canonical State Engine
// SaaS-SAFE • CACHE-SAFE • MULTI-DEVICE • VERSIONED
// =================================================================
(function () {
  'use strict';

  const TABLE = "camp_state";
  const SCHEMA_VERSION = 1;
  const LOCAL_CACHE_KEY = "CAMPISTRY_LOCAL_CACHE";

  async function getUser() {
    const { data } = await window.supabase.auth.getUser();
    return data?.user || null;
  }

  async function loadCloudState() {
    const user = await getUser();
    if (!user) return null;

    const { data } = await window.supabase
      .from(TABLE)
      .select("state")
      .eq("owner_id", user.id)
      .single();

    return data?.state || null;
  }

  async function saveCloudState(state) {
    const user = await getUser();
    if (!user) return;

    state.schema_version = SCHEMA_VERSION;
    state.updated_at = new Date().toISOString();

    await window.supabase.from(TABLE).upsert({
      owner_id: user.id,
      state
    });
  }

  window.loadGlobalSettings = async function () {
    // 1️⃣ Cloud first
    const cloud = await loadCloudState();
    if (cloud && Object.keys(cloud).length) {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cloud));
      return cloud;
    }

    // 2️⃣ Fallback local
    const local = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
    return local;
  };

  window.saveGlobalSettings = async function (k, v) {
    const state = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
    state[k] = v;

    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
    await saveCloudState(state);
  };

})();
