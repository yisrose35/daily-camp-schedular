// daily_activities.js
// Fixed Daily Activities (e.g., Lunch) — per-division, time-bound, toggleable.
// Integrates with existing globals: availableDivisions, divisions, unifiedTimes, scheduleAssignments.
// Exposes: window.DailyActivities = { init, onDivisionsChanged, prePlace }

(function(){
  // -------------------- State & Persistence --------------------
  let fixedActivities = []; 
  // Item: { id, name, start:"HH:MM", end:"HH:MM", divisions:[string], enabled:boolean }

  function save() {
    localStorage.setItem("fixedActivities", JSON.stringify(fixedActivities));
  }
  function load() {
    try {
      const raw = localStorage.getItem("fixedActivities");
      fixedActivities = raw ? JSON.parse(raw) : [];
    } catch {
      fixedActivities = [];
    }
  }

  // -------------------- DOM Helpers --------------------
  function byId(id){ return document.getElementById(id); }

  function renderDivisionChips() {
    const box = byId("fixedDivisionsBox");
    if (!box) return;
    box.innerHTML = "";
    const list = (window.availableDivisions || []);
    list.forEach(div => {
      const id = `fxdiv-${div.replace(/\s+/g,'_')}`;
      const wrap = document.createElement("label");
      wrap.className = "chip";
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" data-div="${div}">
        <span>${div}</span>
      `;
      box.appendChild(wrap);
    });
  }

  function renderList() {
    const list = byId("fixedList");
    if (!list) return;

    if (!fixedActivities.length) {
      list.innerHTML = `<div style="opacity:.7">No fixed activities yet. Add lunch, tefillah, assemblies, etc.</div>`;
      return;
    }

    list.innerHTML = "";
    fixedActivities.forEach((fx, idx) => {
      const row = document.createElement("div");
      row.className = "fixed-row";
      const divs = fx.divisions?.length ? fx.divisions.join(", ") : "All divisions";
      row.innerHTML = `
        <div class="fx-left">
          <div class="fx-title">${fx.name}</div>
          <div class="fx-sub">${fx.start}–${fx.end} • ${divs}</div>
        </div>
        <div class="fx-right">
          <label class="toggle" title="Enable/disable">
            <input type="checkbox" ${fx.enabled ? "checked": ""} data-idx="${idx}">
            <span class="slider"></span>
          </label>
          <button class="fx-del" data-idx="${idx}" title="Delete">✕</button>
        </div>
      `;
      list.appendChild(row);
    });

    // Wire up toggle & delete
    list.querySelectorAll('.toggle input').forEach(inp=>{
      inp.addEventListener('change', (e)=>{
        const i = +e.target.dataset.idx;
        fixedActivities[i].enabled = e.target.checked;
        save();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } catch {}
      });
    });
    list.querySelectorAll('.fx-del').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const i = +e.target.dataset.idx;
        fixedActivities.splice(i,1);
        save();
        renderList();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } catch {}
      });
    });
  }

  function addFromForm() {
    const name  = (byId("fixedName")?.value || "").trim();
    const start = byId("fixedStart")?.value || "";
    const end   = byId("fixedEnd")?.value || "";
    if (!name)  { alert("Please enter an activity name."); return; }
    if (!start || !end) { alert("Please select start and end times."); return; }

    const selected = [];
    document.querySelectorAll("#fixedDivisionsBox input[type='checkbox']").forEach(cb=>{
      if (cb.checked) selected.push(cb.dataset.div);
    });

    const id = "fx_" + Math.random().toString(36).slice(2,9);
    fixedActivities.push({ id, name, start, end, divisions: selected, enabled: true });
    save();

    if (byId("fixedName")) byId("fixedName").value = "";
    renderList();
    try { window.assignFieldsToBunks?.(); } catch {}
    try { window.renderScheduleTable?.(); } catch {}
  }

  // -------------------- Time & Placement Helpers --------------------
  function timeStringToTodayDate(hhmm) {
    const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
    const base = new Date((window.unifiedTimes?.[0]?.start) || Date.now());
    base.setHours(hh || 0, mm || 0, 0, 0);
    return base;
  }

  function rowsForTimeRange(unifiedTimes, startDate, endDate) {
    if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) return [];
    const rows = [];
    for (let i = 0; i < unifiedTimes.length; i++) {
      const row = unifiedTimes[i];
      // overlap if [row.start,row.end) intersects [startDate,endDate)
      if (row.start < endDate && row.end > startDate) rows.push(i);
    }
    return rows;
  }

  // -------------------- Public: prePlace --------------------
  // Call this AFTER you reset scheduleAssignments arrays in assignFieldsToBunks,
  // BEFORE assigning leagues/fields/specials.
  function prePlace(ctx) {
    const {
      scheduleAssignments,
      unifiedTimes,
      divisions,
      availableDivisions
    } = ctx || {};

    const enabledFixed = (fixedActivities || []).filter(x => x.enabled);
    if (!enabledFixed.length) return;

    enabledFixed.forEach(fx => {
      const startD = timeStringToTodayDate(fx.start);
      const endD   = timeStringToTodayDate(fx.end);
      if (!(endD > startD)) return;

      const rows = rowsForTimeRange(unifiedTimes, startD, endD);
      if (!rows.length) return;

      const targetDivs = (fx.divisions?.length ? fx.divisions : (availableDivisions || []));
      targetDivs.forEach(div => {
        const bunksInDiv = (divisions?.[div]?.bunks) || [];
        bunksInDiv.forEach(bunk => {
          if (!scheduleAssignments[bunk]) return;
          let first = true;
          rows.forEach(rIdx => {
            scheduleAssignments[bunk][rIdx] = {
              type: "fixed",
              field: { name: fx.name },
              sport: null,
              continuation: !first,
              _locked: true
            };
            first = false;
          });
        });
      });
    });
  }

  // -------------------- Lifecycle --------------------
  function init() {
    load();
    renderDivisionChips();
    renderList();

    const addBtn = byId("addFixedBtn");
    if (addBtn) addBtn.addEventListener("click", addFromForm);
  }

  function onDivisionsChanged() {
    renderDivisionChips();
    renderList();
  }

  // Expose API
  window.DailyActivities = {
    init,
    onDivisionsChanged,
    prePlace
  };

  // Auto-init when DOM is ready
  window.addEventListener("DOMContentLoaded", init);

})();
