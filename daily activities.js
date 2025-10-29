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

  // Color a division chip based on selection state
  function paintChip(labelEl, checked, divName) {
    const color = (window.divisions?.[divName]?.color) || "#bbb";
    // chip base look
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
      const color = (window.divisions?.[div]?.color) || "#e0e0e0";

      const wrap = document.createElement("label");
      wrap.className = "chip";
      wrap.style.cursor = "pointer";
      wrap.style.userSelect = "none";
      wrap.style.padding = "6px 10px";
      wrap.style.borderRadius = "999px";
      wrap.style.display = "inline-flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "8px";
      wrap.style.margin = "4px 6px 0 0";
      wrap.style.transition = "all .15s ease";

      wrap.innerHTML = `
        <input type="checkbox" id="${id}" data-div="${div}" style="display:none">
        <span class="chip-dot" aria-hidden="true" style="width:10px;height:10px;border-radius:999px;background:${color};display:inline-block;flex:0 0 auto;"></span>
        <span class="chip-label">${div}</span>
      `;
      box.appendChild(wrap);

      const cb = wrap.querySelector("input[type='checkbox']");
      // start unselected, paint neutral
      paintChip(wrap, cb.checked, div);

      // update color when toggled
      cb.addEventListener("change", () => paintChip(wrap, cb.checked, div));

      // also toggle when clicking anywhere on the label (since input is hidden)
      wrap.addEventListener("click", (e) => {
        // prevent double toggles when clicking directly on the hidden input
        if (e.target.tagName.toLowerCase() === "input") return;
        cb.checked = !cb.checked;
        paintChip(wrap, cb.checked, div);
      });
    });
  }

  // Make a small, colored pill for a division (used in list view)
  function makeDivPill(divName) {
    const pill = document.createElement("span");
    const color = (window.divisions?.[divName]?.color) || "#9e9e9e";
    pill.textContent = divName;
    pill.className = "div-pill";
    pill.style.display = "inline-block";
    pill.style.padding = "2px 8px";
    pill.style.borderRadius = "999px";
    pill.style.background = color;
    pill.style.color = "#fff";
    pill.style.fontSize = "12px";
    pill.style.marginRight = "6px";
    pill.style.lineHeight = "18px";
    return pill;
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

      const left = document.createElement("div");
      left.className = "fx-left";

      const title = document.createElement("div");
      title.className = "fx-title";
      title.textContent = fx.name;
      title.style.fontWeight = "600";
      title.style.marginBottom = "4px";

      const sub = document.createElement("div");
      sub.className = "fx-sub";
      sub.style.opacity = ".85";
      sub.style.display = "flex";
      sub.style.flexWrap = "wrap";
      sub.style.alignItems = "center";
      sub.style.gap = "6px";

      const time = document.createElement("span");
      time.textContent = `${fx.start}–${fx.end}`;
      time.style.marginRight = "8px";
      sub.appendChild(time);

      // divisions pills
      const targetDivs = fx.divisions?.length ? fx.divisions : (window.availableDivisions || []);
      if (targetDivs.length) {
        targetDivs.forEach(d => sub.appendChild(makeDivPill(d)));
      } else {
        const pill = makeDivPill("All divisions");
        sub.appendChild(pill);
      }

      left.appendChild(title);
      left.appendChild(sub);

      const right = document.createElement("div");
      right.className = "fx-right";
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "8px";

      // Enable/disable toggle (already supported in your logic)
      const toggleWrap = document.createElement("label");
      toggleWrap.className = "toggle";
      toggleWrap.title = "Enable/disable";
      toggleWrap.style.display = "inline-block";
      toggleWrap.style.position = "relative";
      toggleWrap.style.width = "44px";
      toggleWrap.style.height = "24px";

      const toggleInput = document.createElement("input");
      toggleInput.type = "checkbox";
      toggleInput.checked = !!fx.enabled;
      toggleInput.dataset.idx = idx;
      toggleInput.style.display = "none";

      const slider = document.createElement("span");
      slider.className = "slider";
      slider.style.position = "absolute";
      slider.style.cursor = "pointer";
      slider.style.top = "0";
      slider.style.left = "0";
      slider.style.right = "0";
      slider.style.bottom = "0";
      slider.style.background = fx.enabled ? "#4caf50" : "#bbb";
      slider.style.borderRadius = "999px";
      slider.style.transition = "all .15s ease";

      const knob = document.createElement("span");
      knob.style.position = "absolute";
      knob.style.height = "18px";
      knob.style.width = "18px";
      knob.style.left = fx.enabled ? "24px" : "4px";
      knob.style.top = "3px";
      knob.style.background = "#fff";
      knob.style.borderRadius = "50%";
      knob.style.boxShadow = "0 1px 3px rgba(0,0,0,.25)";
      knob.style.transition = "all .15s ease";

      slider.appendChild(knob);
      toggleWrap.appendChild(toggleInput);
      toggleWrap.appendChild(slider);
      right.appendChild(toggleWrap);

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "fx-del";
      delBtn.dataset.idx = idx;
      delBtn.title = "Delete";
      delBtn.textContent = "✕";
      delBtn.style.border = "1px solid rgba(0,0,0,.12)";
      delBtn.style.background = "#fff";
      delBtn.style.borderRadius = "8px";
      delBtn.style.padding = "4px 8px";
      delBtn.style.cursor = "pointer";
      right.appendChild(delBtn);

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);

      // Wire up toggle (visual + data + re-render schedule)
      toggleWrap.addEventListener("click", (e) => {
        // prevent selecting text etc.
        e.preventDefault();
        const i = +toggleInput.dataset.idx;
        const newState = !fixedActivities[i].enabled;
        fixedActivities[i].enabled = newState;
        // visual
        slider.style.background = newState ? "#4caf50" : "#bbb";
        knob.style.left = newState ? "24px" : "4px";
        save();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } catch {}
      });

      // Wire up delete
      delBtn.addEventListener("click", (e)=>{
        const i = +e.currentTarget.dataset.idx;
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
