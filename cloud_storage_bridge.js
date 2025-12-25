// =================================================================
// cloud_storage_bridge.js — Campistry Canonical Cloud State Engine
// REAL SaaS MODE • Multi-Device • Cache-Safe • Versioned
// =================================================================
(function () {
  'use strict';

  const TABLE = "camp_state";
  const SCHEMA_VERSION = 1;
  const LOCAL_CACHE_KEY = "CAMPISTRY_LOCAL_CACHE";

  // ---------------------------------------------------------------
  // Get active camp (first owned camp for now)
  // ---------------------------------------------------------------
  async function getActiveCamp() {
    const { data } = await window.supabase
      .from("camps")
      .select("id, owner")

      .limit(1)
      .single();
    return data;
  }

  // ---------------------------------------------------------------
  // Cloud load
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
  // Cloud save
  // ---------------------------------------------------------------
  async function saveCloudState(state) {
    const camp = await getActiveCamp();
    if (!camp) return;

    state.schema_version = SCHEMA_VERSION;
    state.updated_at = new Date().toISOString();

    await window.supabase.from(TABLE).upsert({
      camp_id: camp.id,
      owner_id: camp.owner_id,
      state
    });
  }

  // ---------------------------------------------------------------
  // PUBLIC API — these replace your old localStorage system
  // ---------------------------------------------------------------
  window.loadGlobalSettings = async function () {
    // 1️⃣ Cloud first
    const cloud = await loadCloudState();
    if (cloud && Object.keys(cloud).length) {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cloud));
      return cloud;
    }

    // 2️⃣ Fallback local cache
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
