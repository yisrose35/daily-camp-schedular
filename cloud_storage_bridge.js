// =================================================================
// cloud_storage_bridge.js — Forces ALL Campistry storage into Supabase
// =================================================================
(function () {
  'use strict';

  const TABLE = "campistry_kv";   // single-row key/value store

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

  window.loadGlobalSettings = async function () {
    return (await load("global")) || {};
  };

  window.saveGlobalSettings = async function (k, v) {
    const g = (await load("global")) || {};
    g[k] = v;
    await save("global", g);
  };
})();
