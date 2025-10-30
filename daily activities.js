// daily_activities.js
// Fixed Daily Activities (e.g., Lunch) — per-division, time-bound, toggleable.
// Exposes: window.DailyActivities = { init, onDivisionsChanged, prePlace }

(function(){
  // -------------------- State & Persistence --------------------
  let fixedActivities = []; 
  // Item: { id, name, start:"HH:MM", end:"HH:MM", divisions:[string], enabled:boolean }

  function save(){ localStorage.setItem("fixedActivities", JSON.stringify(fixedActivities)); }
  function load(){
    try { fixedActivities = JSON.parse(localStorage.getItem("fixedActivities")) || []; }
    catch { fixedActivities = []; }
    // Migration: ensure enabled flag exists
    let migrated = false;
    fixedActivities.forEach(fx=>{
      if (typeof fx.enabled === "undefined") { fx.enabled = true; migrated = true; }
      if (!Array.isArray(fx.divisions)) { fx.divisions = []; migrated = true; }
    });
    if (migrated) save();
  }

  // -------------------- DOM Helpers --------------------
  const byId = (id)=>document.getElementById(id);
  const getDivColor = (div) => (window.divisions?.[div]?.color) || "#9e9e9e";

  // Paint a chip using the division color when selected
  function paintChip(labelEl, checked, divName){
    if (!labelEl) return;
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
    // VISIBILITY FIX: Use a dark color for unselected state to prevent invisible text
    labelEl.style.color = checked ? "#fff" : "#333"; 
    labelEl.style.boxShadow = checked ? "0 1px 4px rgba(0,0,0,.15)" : "none";
  }

  function renderDivisionChips(){
    const box = byId("fixedDivisionsBox");
    if (!box) { /* console.warn("[DailyActivities] #fixedDivisionsBox not found"); */ return; }
    box.innerHTML = "";
    // Pulls from the global list managed by app1.js
    const list = (window.availableDivisions || []); 
    list.forEach(div=>{
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
      paintChip(wrap, cb.checked, div);

      // click anywhere on the chip
      wrap.addEventListener("click", (e)=>{
        if (e.target.tagName.toLowerCase() === "input") return;
        cb.checked = !cb.checked;
        paintChip(wrap, cb.checked, div);
      });
      // keyboard/assistive changes
      cb.addEventListener("change", ()=> paintChip(wrap, cb.checked, div));
    });
  }

  // pill for list row
  function makeDivPill(divName){
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

  // Compact ON/OFF switch (checkbox-based; less likely to be hidden by global CSS)
  function makeOnOffSwitch(isOn){
    const label = document.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = "8px";
    label.style.cursor = "pointer";

    const txt = document.createElement("span");
    txt.textContent = isOn ? "On" : "Off";

    const box = document.createElement("span");
    box.style.width = "42px";
    box.style.height = "24px";
    box.style.borderRadius = "999px";
    box.style.border = "1px solid rgba(0,0,0,.15)";
    box.style.display = "inline-block";
    box.style.position = "relative";
    box.style.background = isOn ? "#4caf50" : "#e0e0e0";

    const knob = document.createElement("span");
    knob.style.position = "absolute";
    knob.style.top = "2px";
    knob.style.left = isOn ? "22px" : "2px";
    knob.style.width = "20px";
    knob.style.height = "20px";
    knob.style.borderRadius = "50%";
    knob.style.background = "#fff";
    knob.style.boxShadow = "0 1px 3px rgba(0,0,0,.2)";
    knob.style.transition = "left .15s ease";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!isOn;
    input.style.display = "none";

    box.appendChild(knob);
    label.appendChild(box);
    label.appendChild(txt);

    const api = {
      el: label,
      set(on){
        input.checked = !!on;
        txt.textContent = on ? "On" : "Off";
        box.style.background = on ? "#4caf50" : "#e0e0e0";
        knob.style.left = on ? "22px" : "2px";
      },
      onChange(fn){ input.addEventListener("change", ()=> fn(input.checked)); },
      input
    };

    // click toggles hidden input
    label.addEventListener("click", (e)=>{
      if (e.target === input) return;
      input.checked = !input.checked;
      api.set(input.checked);
      input.dispatchEvent(new Event("change"));
    });

    return api;
  }

  function renderList(){
    const list = byId("fixedList");
    if (!list){ /* console.warn("[DailyActivities] #fixedList not found"); */ return; }

    if (!fixedActivities.length){
      list.innerHTML = `<div style="opacity:.7">No fixed activities yet. Add lunch, tefillah, assemblies, etc.</div>`;
      return;
    }

    list.innerHTML = "";
    fixedActivities.forEach((fx, idx)=>{
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
      right.style.gap = "10px";

      // On/Off switch (persisted)
      const sw = makeOnOffSwitch(!!fx.enabled);
      sw.onChange((isOn)=>{
        fixedActivities[idx].enabled = isOn;
        save();
        try { window.assignFieldsToBunks?.(); } catch {}
        try { window.renderScheduleTable?.(); } } catch {}
      });
      right.appendChild(sw.el);

      // Delete
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

  // -------------------- Add from form --------------------
  function addFromForm(){
    const name  = (byId("fixedName")?.value || "").trim();
    const start = byId("fixedStart")?.value || "";
    const end   = byId("fixedEnd")?.value || "";
    if (!name){ alert("Please enter an activity name."); return; }
    if (!start || !end){ alert("Please select start and end times."); return; }

    const selected = [];
    document.querySelectorAll("#fixedDivisionsBox input[type='checkbox']").forEach(cb=>{
      if (cb.checked) selected.push(cb.dataset.div);
    });

    const id = "fx_" + Math.random().toString(36).slice(2,9);
    fixedActivities.push({ id, name, start, end, divisions: selected, enabled: true });
    save();

    // Reset form after successful addition
    if (byId("fixedName")) byId("fixedName").value = "";
    document.querySelectorAll("#fixedDivisionsBox input[type='checkbox']").forEach(cb=>{
      cb.checked = false;
      const wrap = cb.closest("label.chip");
      if (wrap) paintChip(wrap, false, cb.dataset.div);
    });

    renderList();
    try { window.assignFieldsToBunks?.(); } catch {}
    try { window.renderScheduleTable?.(); } catch {}
  }

  // -------------------- Time helpers & prePlacement --------------------
  function timeStringToTodayDate(hhmm){
    const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
    // Use global unifiedTimes from app1.js if available, otherwise fallback to now
    const base = new Date((window.unifiedTimes?.[0]?.start) || Date.now()); 
    base.setHours(hh || 0, mm || 0, 0, 0);
    return base;
  }

  function rowsForTimeRange(unifiedTimes, startDate, endDate){
    if (!Array.isArray(unifiedTimes) || unifiedTimes.length === 0) return [];
    const rows = [];
    for (let i=0;i<unifiedTimes.length;i++){
      const row = unifiedTimes[i];
      if (row.start < endDate && row.end > startDate) rows.push(i);
    }
    return rows;
  }

  // Call BEFORE leagues/fields; AFTER you reset schedule arrays
  function prePlace(ctx){
    // Pulling from ctx or global, depending on how you pass data
    const { scheduleAssignments, unifiedTimes, divisions, availableDivisions } = ctx || {};
    const enabledFixed = (fixedActivities || []).filter(x => x.enabled);
    if (!enabledFixed.length) return;

    enabledFixed.forEach(fx=>{
      const startD = timeStringToTodayDate(fx.start);
      const endD   = timeStringToTodayDate(fx.end);
      if (!(endD > startD)) return;

      const rows = rowsForTimeRange(unifiedTimes, startD, endD);
      if (!rows.length) return;

      const targetDivs = (fx.divisions?.length ? fx.divisions : (availableDivisions || []));
      targetDivs.forEach(div=>{
        const bunksInDiv = (divisions?.[div]?.bunks) || [];
        bunksInDiv.forEach(bunk=>{
          if (!scheduleAssignments[bunk]) return;
          let first = true;
          rows.forEach(rIdx=>{
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
  function init(){
    load();
    renderDivisionChips();
    renderList();
    
    // TIME DEFAULT FIX: Set the default time values
    if (byId("fixedStart")) byId("fixedStart").value = "12:00";
    if (byId("fixedEnd")) byId("fixedEnd").value = "12:30";

    // REMOVED: The unreliable event listener attachment has been removed.
  }

  function onDivisionsChanged(){
    renderDivisionChips();
    renderList();
  }

  window.DailyActivities = { init, onDivisionsChanged, prePlace };
  window.addEventListener("DOMContentLoaded", init);

  // If you use tab buttons, repaint chips when Daily tab is opened
  window.addEventListener("click", (e)=>{
    const btn = e.target.closest?.(".tab-button");
    if (btn && /daily/i.test(btn.textContent || "")) {
      renderDivisionChips();
    }
  });
  
  // *** CRITICAL FIX: Expose the function globally for the HTML onclick handler ***
  window.addFixedActivity = addFromForm; 

})();
