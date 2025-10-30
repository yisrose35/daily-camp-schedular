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
    } catch (e) {
      console.warn("Failed to load fixed activities:", e);
      fixedActivities = [];
    }
  }
  function save() {
    localStorage.setItem(LS_KEY, JSON.stringify(fixedActivities));
  }

  // Accepts "12:00pm", "12:00 pm", "12:00 PM", "12:00" (24h) and returns minutes since 00:00
  function parseTimeToMinutes(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();

    // If user typed 24h like "12:30" or the browser provided type="time" value
    const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      let hh = parseInt(m24[1], 10);
      let mm = parseInt(m24[2], 10);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return hh * 60 + mm;
    }

    // 12h with am/pm: "12:00pm", "9:05 am"
    const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (m12) {
      let hh = parseInt(m12[1], 10);
      let mm = parseInt(m12[2], 10);
      const ap = m12[3];
      if (hh === 12) hh = 0;          // 12am -> 00
      if (ap === "pm") hh += 12;      // add 12 for pm (except 12pm handled by previous line -> becomes 12)
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return hh * 60 + mm;
    }

    // "12pm" without minutes
    const m12simple = s.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (m12simple) {
      let hh = parseInt(m12simple[1], 10);
      const ap = m12simple[2];
      if (hh === 12) hh = 0;
      if (ap === "pm") hh += 12;
      return hh * 60;
    }

    return null;
  }

  function minutesToLabel(mins) {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const ap = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${mm.toString().padStart(2, "0")}${ap}`;
  }

  // -------------------- UI: Division Chips --------------------
  function buildDivisionChips() {
    const box = byId("fixedDivisionsBox");
    if (!box) return;
    box.innerHTML = "";

    const list = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    list.forEach((divName) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = divName;
      btn.className = "chip";
      btn.style.cssText = `
        padding:4px 8px;border:1px solid #ccc;border-radius:12px;background:#f7f7f7;cursor:pointer;
      `;
      btn.dataset.selected = "false";
      btn.addEventListener("click", () => {
        const sel = btn.dataset.selected === "true";
        btn.dataset.selected = (!sel).toString();
        btn.style.background = sel ? "#f7f7f7" : "#dbeafe"; // toggle bg
        btn.style.borderColor = sel ? "#ccc" : "#93c5fd";
      });
      box.appendChild(btn);
    });
  }

  function getSelectedDivisions() {
    const box = byId("fixedDivisionsBox");
    if (!box) return [];
    const out = [];
    box.querySelectorAll("button.chip").forEach((b) => {
      if (b.dataset.selected === "true") out.push(b.textContent.trim());
    });
    return out;
  }

  // -------------------- UI: List --------------------
  function renderList() {
    const wrap = byId("fixedList");
    if (!wrap) return;
    if (!Array.isArray(fixedActivities)) fixedActivities = [];
    wrap.innerHTML = "";

    if (fixedActivities.length === 0) {
      wrap.innerHTML = `<div style="color:#777;">No fixed activities yet.</div>`;
      return;
    }

    fixedActivities
      .slice()
      .sort((a, b) => a.start - b.start)
      .forEach((item) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;";

        const label = document.createElement("div");
        const divs = (item.divisions && item.divisions.length) ? item.divisions.join(", ") : "All";
        label.textContent = `${item.name} • ${minutesToLabel(item.start)}–${minutesToLabel(item.end)} • ${divs}`;

        const del = document.createElement("button");
        del.textContent = "Remove";
        del.style.cssText = "margin-left:auto;background:#ef4444;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;";
        del.addEventListener("click", () => {
          fixedActivities = fixedActivities.filter(f => f.id !== item.id);
          save();
          renderList();
        });

        row.appendChild(label);
        row.appendChild(del);
        wrap.appendChild(row);
      });
  }

  // -------------------- Add Handler --------------------
  function handleAdd() {
    const name = (byId("fixedName")?.value || "").trim();
    const startStr = (byId("fixedStart")?.value || byId("fixedStart")?.placeholder || "").trim();
    const endStr = (byId("fixedEnd")?.value || byId("fixedEnd")?.placeholder || "").trim();

    if (!name) {
      console.warn("Missing name for fixed activity");
      alert("Please enter an activity name.");
      return;
    }

    const start = parseTimeToMinutes(startStr);
    const end = parseTimeToMinutes(endStr);
    if (start == null || end == null) {
      alert("Please enter valid times (e.g., 12:00pm or 12:00).");
      return;
    }
    if (end <= start) {
      alert("End time must be after start time.");
      return;
    }

    const selectedDivs = getSelectedDivisions(); // empty => applies to all

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

    // optional: clear name only
    byId("fixedName").value = "";
  }

  // -------------------- Public API --------------------
  function init() {
    // Ensure DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
      return;
    }

    // Wire button
    const addBtn = byId("addFixedBtn");
    if (addBtn) {
      addBtn.addEventListener("click", handleAdd);
    } else {
      console.warn("#addFixedBtn not found — cannot attach click handler");
    }

    // Build chips and list
    buildDivisionChips();
    load();
    renderList();

    // Optional: if you want to accept Enter in any of the inputs
    ["fixedName", "fixedStart", "fixedEnd"].forEach(id => {
      const el = byId(id);
      if (el) {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") handleAdd();
        });
      }
    });
  }

  // Rebuild chips when divisions change from app1.js
  function onDivisionsChanged() {
    buildDivisionChips();
  }

  // For schedule integration: return array of blocks to pre-place
  // Each block: { name, start, end, divisions (array or "all") }
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
