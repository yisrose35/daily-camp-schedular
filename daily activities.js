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
  const getDivColor = (div) => (window.divisions?.[div]?.color) || "#9e9e9e";

  // Paint a chip like a push button using the division color when selected
  function paintChip(labelEl, checked, divName) {
    const color = getDivColor(divName);
    labelEl.style.cursor = "pointer";
    labelEl.style.userSelect = "none";
    labelEl.style.padding = "6px 10px";
    labelEl.style.borderRadius = "999px";
    labelEl.style.display = "inline-flex";
    labelEl.style.alignItems = "center";
    labelEl.style.gap = "8px";
    labelEl.style.margin = "4px 6px 0 0";
    labelEl.style.transition = "all .15s ease";
    labelEl.style.border = checked ? "1px solid transparent" : "1px solid rgba(0,0,0,.15)";
    labelEl.style.background = checked ? color : "transparent";
    labelEl.style.color = checked ? "#fff" : "inherit";
    labelEl.style.boxShadow = checked ? "0 1px 4px rgba(0,0,0,.15)" : "none";
  }

  function renderDivisionChips() {
    const box = byId("fixedDivisionsBox");
    if (!box) return;
    box.innerHTML = "";

    const list = (window.availableDivisions || []);
    list.forEach(div => {
      const id = `fxdiv-${div.replace(/\s+/g,'_')}`;
      const color = getDivColor(div);

      const wrap = document.createElement("label");
      wrap.className = "chip";
      wrap.setAttribute("data-div", div);
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" data-div="${div}" style="display:none" aria-label="${div}">
        <span class="chip-dot" aria-hidden="true" style="width:10px;height:10px;border-radius:999px;background:${color};display:inline-block;flex:0 0 auto;"></span>
        <span class="chip-label">${div}</span>
      `;
      box.appendChild(wrap);

      const cb = wrap.querySelector("input[type='checkbox']");
      // initial paint (unchecked)
      paintChip(wrap, cb.checked, div);

      // Toggle via click anywhere on the label (mouse)
      wrap.addEventListener("click", (e) => {
        if (e.target.tagName.toLowerCase() === "input") return;
        cb.checked = !cb.checked;
        paintChip(wrap, cb.checked, div);
      });

      // Also react to keyboard/assistive tech changes
      cb.addEventListener("change", () => {
        paintChip(wrap, cb.checked, div);
      });
    });
  }

  // Small colored pill for list view
  function makeDivPill(divName) {
    const pill = document.createElement("span");
    pill.textContent = divName;
    pill.style.display = "inline-block";
    pill.style.padding = "2px 8px";
    pill.style.borderRadius = "999px";
    pill.style.background = getDivColor(divName);
    pill.style.color = "#fff";
    pill.style.fontSize = "12px";
    pill.style.marginRight = "6px";
    pill.style.lineHeight = "18px";
    return pill;
  }

  // Simple, CSS-free ON/OFF button (persisted)
  function makeOnOffButton(isOn) {
    const btn = document.createElement("button");
    btn.textContent = isOn ? "On" : "Off";
    btn.setAttribute("aria-pressed", String(!!isOn));
    btn.style.minWidth = "56px";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "999px";
    btn.style.border = "1px solid rgba(0,0,0,.15)";
    btn.style.cursor = "pointer";
    btn.style.fontWeight = "600";
    btn.style.background = isOn ? "#4caf50" : "#e0e0e0";
    btn.style.color = isOn ? "#fff" : "#222";
    return btn;
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
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.border = "1px solid rgba(0,0,0,.08)";
      row.style.borderRadius = "12px";
      row.style.padding = "10px 12px";
      row.style.margin = "8px 0";
      row.style.gap = "10px";

      const left = document.createElement("div");
      left.style.minWidth = "0";

      const title = document.createElement("div");
      title.textContent = fx.name;
      title.style.fontWeight = "600";
      title.style.marginBottom = "4px";

      const sub = document.createElement("div");
      sub.style.opacity = ".9";
      sub.style.display = "flex";
      sub.style.flexWrap = "wrap";
      sub.style.alignItems = "center";
      sub.style.gap = "6px";

      const time = document.createElement("span");
      time.textContent = `${fx.start}–${fx.end}`;
      time.style.marginRight = "8px";
      sub.appendChild(time);

      const targetDivs = fx.divisions?.length ? fx.divisions : (window.availableDivisions || []);
      targetDivs.forEach(d => sub.appendChild(makeDivPill(d)));

      left.appendChild(title);
      left.appendChild(sub);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "8px";

      // Visible ON/OFF toggle (persisted + re-renders schedule immediately)
      const toggleBtn = makeOnOffButton(!!fx.enabled);
      toggleBtn.title = "Enable/disable this fixed activity";
      toggleBtn.addEventListener("click", () => {
        const newState = !fixedActivities[idx].enabled;
        fixedActivities[idx].enabled = newState;
        // update visuals
        toggleBtn.textContent = newState ? "On" : "Off";
        toggleBtn.style.background = newState ? "#4caf50" : "#e0e0e0";
        toggleBtn.style.color = newState ? "#fff" : "#222";
        toggleBtn.setAttribute("aria-pressed", String(newState));
        save();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } catch {}
      });
      right.appendChild(toggleBtn);

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.textContent = "Remove";
      delBtn.title = "Delete";
      delBtn.style.border = "1px solid rgba(0,0,0,.15)";
      delBtn.style.background = "#fff";
      delBtn.style.borderRadius = "8px";
      delBtn.style.padding = "6px 10px";
      delBtn.style.cursor = "pointer";
      delBtn.addEventListener("click", ()=>{
        fixedActivities.splice(idx,1);
        save();
        renderList();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } catch {}
      });
      right.appendChild(delBtn);

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
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
    // Clear checks & repaint chips
    document.querySelectorAll("#fixedDivisionsBox input[type='checkbox']").forEach(cb=>{
      cb.checked = false;
      const wrap = cb.closest("label.chip");
      if (wrap) paintChip(wrap, false, cb.dataset.div);
    });

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
