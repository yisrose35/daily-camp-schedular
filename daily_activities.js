// daily_activities.js
// Fixed Daily Activities manager: Lunch, Assembly, etc.
// Exposes: window.DailyActivities = { init, onDivisionsChanged, prePlace }

(function () {
  // -------------------- State --------------------
  let fixedActivities = []; // [{id,name,start,end,divisions:[],enabled:true}]
  const LS_KEY = "fixedActivities";

  // -------------------- Utilities --------------------
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      fixedActivities = raw ? JSON.parse(raw) : [];
    } catch {
      fixedActivities = [];
    }
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(fixedActivities));
  }

  // Accepts "12:00pm", "12:00 pm", "12:00" (24h), "12pm"
  function parseTimeToMinutes(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();

    const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      let hh = +m24[1], mm = +m24[2];
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return hh * 60 + mm;
    }

    const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m12) {
      let hh = +m12[1];
      let mm = m12[2] ? +m12[2] : 0;
      const ap = m12[3].toLowerCase();
      if (hh === 12) hh = 0;          // 12am -> 00, 12pm handled by pm add
      if (ap === "pm") hh += 12;
      return hh * 60 + mm;
    }

    return null;
  }
  function minutesToLabel(mins) {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const ap = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${mm.toString().padStart(2, "0")} ${ap}`;
  }

  // -------------------- Division Chips (push-box buttons) --------------------
  function buildDivisionChips() {
    const box = byId("fixedDivisionsBox");
    if (!box) return;
    box.innerHTML = "";
    box.classList.add("chips");

    const list = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    list.forEach((divName) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = divName;
      btn.className = "chip-toggle";
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", pressed ? "false" : "true");
      });
      box.appendChild(btn);
    });

    // helper actions
    const actions = document.createElement("div");
    actions.className = "chip-actions";
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "chip-ghost";
    selectAll.textContent = "Select all";
    selectAll.onclick = () => box.querySelectorAll(".chip-toggle").forEach(b => b.setAttribute("aria-pressed","true"));

    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "chip-ghost";
    clearAll.textContent = "Clear";
    clearAll.onclick = () => box.querySelectorAll(".chip-toggle").forEach(b => b.setAttribute("aria-pressed","false"));

    actions.appendChild(selectAll);
    actions.appendChild(clearAll);
    box.parentElement?.appendChild(actions);
  }

  function getSelectedDivisions() {
    const box = byId("fixedDivisionsBox");
    if (!box) return [];
    const out = [];
    box.querySelectorAll(".chip-toggle[aria-pressed='true']").forEach(b => {
      out.push(b.textContent.trim());
    });
    return out;
  }

  // -------------------- List Rendering --------------------
  function renderList() {
    const wrap = byId("fixedList");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (!Array.isArray(fixedActivities) || fixedActivities.length === 0) {
      wrap.innerHTML = `<div style="color:#777;">No fixed activities yet.</div>`;
      return;
    }

    fixedActivities
      .slice()
      .sort((a, b) => a.start - b.start)
      .forEach((item) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eee;";

        const info = document.createElement("div");
        info.style.flex = "1 1 auto";
        const divs = (item.divisions && item.divisions.length) ? item.divisions.join(", ") : "All";
        info.textContent = `${item.name} — ${minutesToLabel(item.start)} to ${minutesToLabel(item.end)} • ${divs}`;

        const status = document.createElement("span");
        status.textContent = item.enabled ? "ENABLED" : "DISABLED";
        status.style.cssText = `font-size:12px;padding:2px 6px;border-radius:8px;
          ${item.enabled ? "background:#dcfce7;color:#166534;border:1px solid #86efac" : "background:#fee2e2;color:#991b1b;border:1px solid #fecaca"}`;

        const toggle = document.createElement("button");
        toggle.textContent = item.enabled ? "Disable" : "Enable";
        toggle.style.cssText = "background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:6px 10px;cursor:pointer;";
        toggle.addEventListener("click", () => {
          item.enabled = !item.enabled;
          save();
          renderList();
        });

        const del = document.createElement("button");
        del.textContent = "Remove";
        del.style.cssText = "background:#ef4444;color:#fff;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;";
        del.addEventListener("click", () => {
          fixedActivities = fixedActivities.filter(f => f.id !== item.id);
          save();
          renderList();
        });

        row.appendChild(info);
        row.appendChild(status);
        row.appendChild(toggle);
        row.appendChild(del);
        wrap.appendChild(row);
      });
  }

  // -------------------- Add Handler --------------------
  function handleAdd() {
    const name = (byId("fixedName")?.value || "").trim();
    // allow placeholder examples if user didn’t type
    const startStr = (byId("fixedStart")?.value || byId("fixedStart")?.placeholder || "").trim();
    const endStr = (byId("fixedEnd")?.value || byId("fixedEnd")?.placeholder || "").trim();

    if (!name) { alert("Please enter an activity name."); return; }

    const start = parseTimeToMinutes(startStr);
    const end = parseTimeToMinutes(endStr);
    if (start == null || end == null) { alert("Enter valid times (e.g., 12:00pm)."); return; }
    if (end <= start) { alert("End time must be after start time."); return; }

    const selectedDivs = getSelectedDivisions(); // empty = all
    const item = {
      id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      name,
      start,
      end,
      divisions: selectedDivs,
      enabled: true,
    };

    fixedActivities.push(item);
    save();
    renderList();
    byId("fixedName").value = "";
  }

  // -------------------- Public API --------------------
  function init() {
    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); return; }

    const addBtn = byId("addFixedBtn");
    if (addBtn) addBtn.addEventListener("click", handleAdd);

    // Ensure placeholders show examples (not HTML time inputs)
    const fs = byId("fixedStart"); if (fs) { fs.type = "text"; fs.placeholder = fs.placeholder || "e.g., 12:00pm"; }
    const fe = byId("fixedEnd");   if (fe) { fe.type = "text"; fe.placeholder = fe.placeholder || "e.g., 12:30pm"; }

    buildDivisionChips();
    load();
    renderList();

    ["fixedName", "fixedStart", "fixedEnd"].forEach(id => {
      const el = byId(id);
      if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAdd(); });
    });
  }

  function onDivisionsChanged() {
    // Rebuild chips, keep selections when possible
    const prev = new Set(getSelectedDivisions());
    buildDivisionChips();
    const box = byId("fixedDivisionsBox");
    if (box && prev.size) {
      box.querySelectorAll(".chip-toggle").forEach(b => {
        if (prev.has(b.textContent.trim())) b.setAttribute("aria-pressed","true");
      });
    }
  }

  // For schedule integration
  function prePlace() {
    return fixedActivities
      .filter(f => f.enabled)
      .map(f => ({
        name: f.name,
        start: f.start,
        end: f.end,
        divisions: (f.divisions && f.divisions.length) ? f.divisions.slice() : "all",
      }));
  }

  // Attach to window
  window.DailyActivities = { init, onDivisionsChanged, prePlace };
})();
