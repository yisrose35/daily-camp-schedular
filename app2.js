/* app2.js — Previous working version (before duration support)
 *
 * What it does:
 *  - Builds the visible schedule from saved data (LocalStorage)
 *  - One item per time slot (each slot = current increment)
 *  - Greys out cells outside each division/grade's allowed window
 *  - Renders fields (e.g., "f7 – Basketball") and league lines
 *  - Adds subtle division color accents to the grid cells/headers
 *
 * Required DOM (built by app1.js):
 *  - <table id="scheduleTable"> with a <tbody>
 *  - Body cells for bunks have:   td[data-bunk="<bunkId>"][data-time="<H:MM AM/PM>"]
 *  - (Optional) Division banner cells per time have:
 *      td[data-division-banner="<divisionId>"][data-time="<H:MM AM/PM>"]
 *
 * Data in LocalStorage (keys can be adjusted below if yours differ):
 *  - "TIME_SETTINGS": { dayStart, dayEnd, incrementMin }
 *  - "DIVISIONS": [{ id, name, color?, startTime?, endTime? }, ...]
 *  - "BUNKS":     [{ id, name, divisionId }, ...]
 *  - "FIELDS":    [{ id, name, short? }, ...] (optional)
 *  - "SCHEDULE_ITEMS": array of items, where each item is either:
 *      Activity item:
 *        { id, type:"activity", bunkId, start:"11:00 AM", label:"Basketball", field:"f7" | fieldId? }
 *      League line (division-wide banner for that time):
 *        { id, type:"league",  divisionId, start:"11:00 AM", text:"1 vs 4 (Kickball) • 2 vs 3 (Basketball)" }
 */

(function () {
  // ---------------- Utilities ----------------
  function toMinutes(t12) {
    if (!t12 || typeof t12 !== "string") return 0;
    const [time, ampmRaw] = t12.trim().split(/\s+/);
    const ampm = (ampmRaw || "").toUpperCase();
    let [h, m] = (time || "0:00").split(":").map(Number);
    if (isNaN(h)) h = 0;
    if (isNaN(m)) m = 0;
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + m;
  }

  function toTimeString(minutes) {
    minutes = Math.max(0, minutes) % (24 * 60);
    let h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  }

  function safeText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object") {
      // Avoid [object Object] — try common properties first
      if (v.name) return String(v.name);
      if (v.label) return String(v.label);
      try { return JSON.stringify(v); } catch { return ""; }
    }
    return "";
  }

  // ---------------- LocalStorage helpers ----------------
  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, val) {
      localStorage.setItem(key, JSON.stringify(val));
    }
  };

  // ---------------- Keys (adjust if your project differs) ----------------
  const KEY_TIME   = "TIME_SETTINGS";
  const KEY_DIVS   = "DIVISIONS";
  const KEY_BUNKS  = "BUNKS";
  const KEY_FIELDS = "FIELDS";
  const KEY_ITEMS  = "SCHEDULE_ITEMS";

  // ---------------- Load state ----------------
  let timeSettings = LS.get(KEY_TIME, {
    dayStart: "9:00 AM",
    dayEnd: "5:00 PM",
    incrementMin: 30
  });

  let divisions = LS.get(KEY_DIVS, []);
  let bunks     = LS.get(KEY_BUNKS, []);
  let fields    = LS.get(KEY_FIELDS, []);
  let items     = LS.get(KEY_ITEMS, []);

  // Indexes for faster lookups
  const bunkById      = Object.fromEntries(bunks.map(b => [String(b.id), b]));
  const divisionById  = Object.fromEntries(divisions.map(d => [String(d.id), d]));
  const fieldById     = Object.fromEntries(fields.map(f => [String(f.id), f]));

  // ---------------- Grid building ----------------
  function buildTimeSlots() {
    const inc = Number(timeSettings.incrementMin) || 30;
    const startMin = toMinutes(timeSettings.dayStart);
    const endMin   = toMinutes(timeSettings.dayEnd);
    const out = [];
    for (let t = startMin; t < endMin; t += inc) {
      out.push(toTimeString(t));
    }
    return out;
  }

  function renderScheduleTable() {
    const table = document.getElementById("scheduleTable");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    // Header row is assumed to be already in the THEAD (built by app1)
    // We only build body rows here.
    const timeSlots = buildTimeSlots();

    for (let i = 0; i < timeSlots.length; i++) {
      const start = timeSlots[i];
      const end   = toTimeString(toMinutes(start) + (Number(timeSettings.incrementMin) || 30));

      const tr = document.createElement("tr");

      // Left time cell
      const tdTime = document.createElement("td");
      tdTime.className = "time-cell";
      tdTime.textContent = `${start} - ${end}`;
      tr.appendChild(tdTime);

      // Bunk cells
      bunks.forEach((b) => {
        const td = document.createElement("td");
        td.dataset.bunk = String(b.id);
        td.dataset.time = start;
        // Add subtle division color accent if available
        const div = divisionById[String(b.divisionId)];
        if (div?.color) {
          td.style.boxShadow = `inset 3px 0 0 0 ${div.color}`;
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);

      // Optional "division banner row" below (one line per division for leagues)
      // Only create if app1 prepared a separate row; otherwise we’ll target
      // cells with [data-division-banner] when present.
      // (No-op here; we just rely on existing banner cells if they exist.)
    }
  }

  // ---------------- Grey-out logic ----------------
  function applyGreyOut() {
    const table = document.getElementById("scheduleTable");
    if (!table) return;

    const inc = Number(timeSettings.incrementMin) || 30;
    const startMin = toMinutes(timeSettings.dayStart);
    const cells = table.querySelectorAll("tbody td[data-bunk][data-time]");

    cells.forEach((cell) => {
      cell.classList.remove("greyed");
      const bunkId = String(cell.dataset.bunk);
      const bunk = bunkById[bunkId];
      if (!bunk) return;

      const division = divisionById[String(bunk.divisionId)];
      const windowStart = toMinutes(division?.startTime || timeSettings.dayStart);
      const windowEnd   = toMinutes(division?.endTime   || timeSettings.dayEnd);

      const cellStart = toMinutes(cell.dataset.time);
      // Cell represents [cellStart, cellStart+inc)
      if (cellStart < windowStart || cellStart >= windowEnd) {
        cell.classList.add("greyed");
      }
    });
  }

  // ---------------- Item rendering ----------------
  function fmtFieldPrefix(item) {
    // Field can be a short code (e.g., 'f7') or an id we can resolve
    if (item.field) return String(item.field);
    if (item.fieldId && fieldById[String(item.fieldId)]) {
      const f = fieldById[String(item.fieldId)];
      return safeText(f.short || f.name || f.id);
    }
    return "";
  }

  function placeActivities() {
    const table = document.getElementById("scheduleTable");
    if (!table) return;

    // Clear previous content (but keep greyed state & style)
    const bunkCells = table.querySelectorAll("tbody td[data-bunk][data-time]");
    bunkCells.forEach((td) => {
      // Do not clear the greyed class
      td.textContent = "";
      td.removeAttribute("title");
    });

    // Activities: type === "activity" (default if type missing)
    items
      .filter(it => !it.type || it.type === "activity")
      .forEach((it) => {
        const bunkId = String(it.bunkId ?? "");
        const start  = String(it.start ?? "");
        if (!bunkId || !start) return;

        const cell = table.querySelector(`tbody td[data-bunk="${CSS.escape(bunkId)}"][data-time="${CSS.escape(start)}"]`);
        if (!cell) return;

        // Build label safely
        const fieldPrefix = fmtFieldPrefix(it);
        const label = safeText(it.label);
        const text = fieldPrefix ? `${fieldPrefix} – ${label}` : label;

        cell.textContent = text;
        // Useful hover: shows bunk + time
        cell.title = `${start} • ${label}`;
      });
  }

  function placeLeagues() {
    // League lines typically appear as one banner per division per time
    // We support two ways:
    //  1) If your grid has dedicated cells: td[data-division-banner="<divisionId>"][data-time="<time>"]
    //  2) Otherwise, we write the league text into the *first bunk cell* of that division at that time.
    const table = document.getElementById("scheduleTable");
    if (!table) return;

    const leagues = items.filter(it => it.type === "league");
    if (leagues.length === 0) return;

    // Group bunks by division to know "first bunk cell" fallback
    const bunksByDiv = new Map();
    bunks.forEach((b) => {
      const k = String(b.divisionId);
      if (!bunksByDiv.has(k)) bunksByDiv.set(k, []);
      bunksByDiv.get(k).push(b);
    });

    leagues.forEach((lg) => {
      const divId = String(lg.divisionId ?? "");
      const time  = String(lg.start ?? "");
      if (!divId || !time) return;

      const bannerCell = table.querySelector(
        `tbody td[data-division-banner="${CSS.escape(divId)}"][data-time="${CSS.escape(time)}"]`
      );

      const text = safeText(lg.text);

      if (bannerCell) {
        bannerCell.textContent = text;
        // add division color accent if possible
        const div = divisionById[divId];
        if (div?.color) {
          bannerCell.style.background = hexToTint(div.color, 0.08);
          bannerCell.style.borderLeft = `4px solid ${div.color}`;
          bannerCell.style.fontWeight = "600";
        }
        return;
      }

      // Fallback: write to first bunk of that division at that time
      const bunksInDiv = (bunksByDiv.get(divId) || []).sort((a, b) =>
        String(a.name || a.id).localeCompare(String(b.name || b.id))
      );
      if (bunksInDiv.length === 0) return;

      const firstBunk = bunksInDiv[0];
      const cell = table.querySelector(
        `tbody td[data-bunk="${CSS.escape(String(firstBunk.id))}"][data-time="${CSS.escape(time)}"]`
      );
      if (cell) {
        cell.textContent = text;
        cell.style.fontWeight = "600";
      }
    });
  }

  // ---------------- Visual accents/helpers ----------------
  function applyDivisionHeaderColors() {
    // If your THEAD has bunk headers marked with data-bunk-header="<bunkId>",
    // add an underline or background tint using the division color.
    const headers = document.querySelectorAll('thead th[data-bunk-header]');
    headers.forEach((th) => {
      const bunkId = String(th.getAttribute('data-bunk-header') || "");
      const bunk = bunkById[bunkId];
      if (!bunk) return;
      const div = divisionById[String(bunk.divisionId)];
      if (!div?.color) return;
      th.style.borderBottom = `3px solid ${div.color}`;
      th.style.background = hexToTint(div.color, 0.05);
    });
  }

  function hexToTint(hex, alpha) {
    // supports #RGB or #RRGGBB
    if (!hex || typeof hex !== "string") return "";
    let r, g, b;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    } else {
      return "";
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---------------- Master render ----------------
  function clearDivisionBanners() {
    const table = document.getElementById("scheduleTable");
    if (!table) return;
    const banners = table.querySelectorAll('tbody td[data-division-banner][data-time]');
    banners.forEach(td => { td.textContent = ""; });
  }

  function render() {
    // Refresh state (in case app1.js changed settings/masters)
    timeSettings = LS.get(KEY_TIME, timeSettings);
    divisions    = LS.get(KEY_DIVS, divisions);
    bunks        = LS.get(KEY_BUNKS, bunks);
    fields       = LS.get(KEY_FIELDS, fields);
    items        = LS.get(KEY_ITEMS, items);

    // Rebuild quick indexes
    Object.keys(bunkById).forEach(k => delete bunkById[k]);
    bunks.forEach(b => { bunkById[String(b.id)] = b; });

    Object.keys(divisionById).forEach(k => delete divisionById[k]);
    divisions.forEach(d => { divisionById[String(d.id)] = d; });

    Object.keys(fieldById).forEach(k => delete fieldById[k]);
    fields.forEach(f => { fieldById[String(f.id)] = f; });

    // Build the body grid, then decorate + fill
    renderScheduleTable();
    applyDivisionHeaderColors();
    applyGreyOut();
    clearDivisionBanners();
    placeActivities();
    placeLeagues();
  }

  // ---------------- Events & public API ----------------
  // Re-render when app1 signals the grid changed (e.g., new increment, new bunks)
  document.addEventListener("grid:rebuilt", render);

  // Initial render
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }

  // Expose a tiny API for other scripts (optional convenience)
  window.ScheduleApp = {
    render,
    reloadFromStorage() { render(); },
    setItems(newItems) {
      items = Array.isArray(newItems) ? newItems : [];
      LS.set(KEY_ITEMS, items);
      render();
    },
    pushItem(item) {
      items = LS.get(KEY_ITEMS, []);
      const withId = { id: item.id || `it_${Date.now()}`, ...item };
      items.push(withId);
      LS.set(KEY_ITEMS, items);
      render();
      return withId.id;
    },
    replaceItem(id, patch) {
      items = LS.get(KEY_ITEMS, []);
      const idx = items.findIndex(x => x.id === id);
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...patch };
        LS.set(KEY_ITEMS, items);
        render();
      }
    },
    deleteItem(id) {
      items = LS.get(KEY_ITEMS, []);
      items = items.filter(x => x.id !== id);
      LS.set(KEY_ITEMS, items);
      render();
    },
    // For convenience if you change increment from a UI control:
    updateIncrement(mins) {
      const ts = LS.get(KEY_TIME, timeSettings);
      ts.incrementMin = Number(mins);
      LS.set(KEY_TIME, ts);
      render();
    }
  };
})();
    // Derived from DOM on first render:
    grid: {
      rows: 0,
      cols: [], // array of column keys from data-col attributes
      table: null, // reference to #scheduleTable
      timeSlots: [], // array of slot start times (minutes from midnight)
      dayStartMin: 9 * 60,
      dayEndMin: 17 * 60,
      slotMin: 15,
    },

    // Per-division allowed windows. If empty, uses division.window or global.
    divisionWindows: {}, // { [divisionId]: { start:"9:30 AM", end:"4:00 PM" } }
  };

  // ---------- Time utils ----------
  function toMinutes(t12) {
    // Accepts "H:MM AM/PM" or "HH:MM AM/PM"
    if (!t12 || typeof t12 !== "string") return 0;
    const parts = t12.trim().split(/\s+/);
    const ampm = (parts[1] || "").toUpperCase();
    let [h, m] = (parts[0] || "0:00").split(":").map(Number);
    if (isNaN(h)) h = 0;
    if (isNaN(m)) m = 0;
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    return h * 60 + m;
  }

  function toT12(mins) {
    mins = Math.max(0, mins) % (24 * 60);
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  }

  function slotIndexFor(startT12, dayStartMin, slotMin) {
    return Math.round((toMinutes(startT12) - dayStartMin) / slotMin);
  }

  function slotsFor(durationMin, slotMin) {
    const d = Number(durationMin) || slotMin;
    return Math.max(1, Math.ceil(d / slotMin));
  }

  function buildTimeSlots(dayStartMin, dayEndMin, slotMin) {
    const slots = [];
    for (let t = dayStartMin; t < dayEndMin; t += slotMin) {
      slots.push(t);
    }
    return slots;
  }

  // ---------- Division / Column helpers ----------
  function bunkById(id) {
    return state.bunks.find((b) => String(b.id) === String(id));
  }
  function divisionById(id) {
    return state.divisions.find((d) => String(d.id) === String(id));
  }
  function divisionIdForColumn(colKey) {
    // Columns are bunks -> find bunk -> its divisionId
    const bunk = bunkById(colKey);
    return bunk ? bunk.divisionId : null;
  }
  function allowedWindowForDivision(divId) {
    // 1) explicit override set via API
    const manual = state.divisionWindows[divId];
    if (manual && manual.start && manual.end) return manual;

    // 2) division.window on the division itself
    const div = divisionById(divId);
    if (div && div.window && div.window.start && div.window.end) return div.window;

    // 3) fallback to global day window
    return { start: state.timeSettings.dayStart, end: state.timeSettings.dayEnd };
  }

  // ---------- Grid (re)sync from DOM ----------
  function rebuildFromDOM() {
    const table = document.getElementById("scheduleTable");
    if (!table) return;

    // Collect columns from first data-row row we find
    const bodyCells = table.querySelectorAll('tbody td[data-col]');
    const colSet = new Set();
    bodyCells.forEach((td) => {
      const col = td.getAttribute("data-col");
      if (col) colSet.add(col);
    });
    const cols = Array.from(colSet);

    // Collect max row index
    let maxRow = -1;
    bodyCells.forEach((td) => {
      const r = Number(td.getAttribute("data-row"));
      if (!isNaN(r)) maxRow = Math.max(maxRow, r);
    });

    const slotMin = Number(state.timeSettings.incrementMin) || 15;
    const dayStartMin = toMinutes(state.timeSettings.dayStart);
    const dayEndMin = toMinutes(state.timeSettings.dayEnd);

    state.grid.table = table;
    state.grid.cols = cols;
    state.grid.rows = maxRow + 1;
    state.grid.slotMin = slotMin;
    state.grid.dayStartMin = dayStartMin;
    state.grid.dayEndMin = dayEndMin;
    state.grid.timeSlots = buildTimeSlots(dayStartMin, dayEndMin, slotMin);
  }

  // ---------- Grey-out logic ----------
  function applyGreyOut() {
    const { table, cols, rows, slotMin, dayStartMin } = state.grid;
    if (!table) return;

    for (let r = 0; r < rows; r++) {
      const slotStartMin = dayStartMin + r * slotMin;

      cols.forEach((colKey) => {
        const td = table.querySelector(`tbody td[data-row="${r}"][data-col="${colKey}"]`);
        if (!td) return;

        const divId = divisionIdForColumn(colKey);
        const win = allowedWindowForDivision(divId);
        const allowStart = toMinutes(win.start);
        const allowEnd = toMinutes(win.end);

        // If the slot start is outside allowed window → grey it
        if (slotStartMin < allowStart || slotStartMin >= allowEnd) {
          td.classList.add("greyed");
          td.dataset.greyed = "1";
        } else {
          td.classList.remove("greyed");
          delete td.dataset.greyed;
        }
      });
    }
  }

  // ---------- Main render ----------
  function clearCells() {
    const { table, cols, rows } = state.grid;
    if (!table) return;

    for (let r = 0; r < rows; r++) {
      cols.forEach((colKey) => {
        const td = table.querySelector(`tbody td[data-row="${r}"][data-col="${colKey}"]`);
        if (!td) return;
        // Reset any previous rowspan/visibility
        td.style.display = "";
        td.removeAttribute("rowspan");
        td.classList.remove("continued", "activity", "conflict");
        // Keep greyed if applied by applyGreyOut()
        if (!td.classList.contains("greyed")) {
          td.textContent = "";
        } else {
          // leave grey stripes visible; clear any old text
          td.textContent = "";
        }
      });
    }
  }

  function renderItems() {
    const { table, cols, rows, slotMin, dayStartMin, timeSlots } = state.grid;
    if (!table) return;

    // Occupancy map: `${row}:${colKey}` -> true
    const occupied = new Map();

    // Keep items sorted by start time so rowspans nest predictably
    const itemsSorted = [...state.items].sort((a, b) => {
      const sa = toMinutes(a.start);
      const sb = toMinutes(b.start);
      if (sa !== sb) return sa - sb;
      const ca = (a.bunkId ?? a.fieldId ?? a.divisionId ?? "").toString();
      const cb = (b.bunkId ?? b.fieldId ?? b.divisionId ?? "").toString();
      return ca.localeCompare(cb);
    });

    for (const item of itemsSorted) {
      const colKey = (item.bunkId ?? item.fieldId ?? item.divisionId ?? "").toString();
      if (!cols.includes(colKey)) continue;

      const rowStart = slotIndexFor(item.start, dayStartMin, slotMin);
      if (rowStart < 0 || rowStart >= rows) continue;

      const span = slotsFor(item.durationMin ?? slotMin, slotMin);
      const actualSpan = Math.min(span, rows - rowStart);

      // Skip if any covered cell is greyed (out of allowed window)
      let blockedByGrey = false;
      for (let r = rowStart; r < rowStart + actualSpan; r++) {
        const td = table.querySelector(`tbody td[data-row="${r}"][data-col="${colKey}"]`);
        if (td && td.classList.contains("greyed")) {
          blockedByGrey = true;
          break;
        }
      }
      if (blockedByGrey) continue;

      // Check overlap
      let overlap = false;
      for (let r = rowStart; r < rowStart + actualSpan; r++) {
        if (occupied.get(`${r}:${colKey}`)) {
          overlap = true;
          break;
        }
      }

      const anchor = table.querySelector(`tbody td[data-row="${rowStart}"][data-col="${colKey}"]`);
      if (!anchor) continue;

      if (overlap) {
        anchor.classList.add("conflict");
        // Still mark occupied for visibility (optional)
        continue;
      }

      // Apply rowspan + content
      if (actualSpan > 1) anchor.setAttribute("rowspan", String(actualSpan));
      anchor.classList.add("activity");

      const fieldTag = item.meta && item.meta.field ? `${item.meta.field} – ` : "";
      const label = (item.label && typeof item.label === "string") ? item.label : (item.label?.toString?.() ?? "");
      const endMin = toMinutes(item.start) + (Number(item.durationMin) || slotMin);
      anchor.textContent = `${fieldTag}${label} (${item.start}–${toT12(endMin)})`;

      // Hide continued cells
      for (let r = rowStart + 1; r < rowStart + actualSpan; r++) {
        const td = table.querySelector(`tbody td[data-row="${r}"][data-col="${colKey}"]`);
        if (td) {
          td.classList.add("continued");
          td.style.display = "none";
        }
      }

      // Occupy
      for (let r = rowStart; r < rowStart + actualSpan; r++) {
        occupied.set(`${r}:${colKey}`, true);
      }
    }
  }

  function render() {
    // Keep runtime settings refreshed from LS (in case app1 changed them)
    state.timeSettings = LS.get(KEY_TIME, state.timeSettings);
    state.divisions = LS.get(KEY_DIVS, state.divisions);
    state.bunks = LS.get(KEY_BUNKS, state.bunks);
    state.fields = LS.get(KEY_FIELDS, state.fields);
    state.items = LS.get(KEY_ITEMS, state.items);

    rebuildFromDOM();
    clearCells();
    applyGreyOut();
    renderItems();
  }

  // ---------- Public API ----------
  function addItem(item) {
    // Ensure shape
    const id = item.id || `it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clean = {
      id,
      label: String(item.label || "").trim(),
      bunkId: item.bunkId ?? null,
      divisionId: item.divisionId ?? null,
      fieldId: item.fieldId ?? null,
      start: item.start || state.timeSettings.dayStart,
      durationMin: Number(item.durationMin) || state.timeSettings.incrementMin,
      meta: item.meta || {},
    };
    state.items.push(clean);
    LS.set(KEY_ITEMS, state.items);
    render();
    return id;
  }

  function removeItem(id) {
    state.items = state.items.filter((x) => x.id !== id);
    LS.set(KEY_ITEMS, state.items);
    render();
  }

  function upsertItems(itemsArray) {
    const byId = new Map(state.items.map((i) => [i.id, i]));
    itemsArray.forEach((it) => {
      if (!it.id) it.id = `it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      byId.set(it.id, { ...byId.get(it.id), ...it });
    });
    state.items = Array.from(byId.values());
    LS.set(KEY_ITEMS, state.items);
    render();
  }

  function setDivisionWindows(map) {
    // map: { [divisionId]: { start:"10:00 AM", end:"3:30 PM" } }
    state.divisionWindows = { ...state.divisionWindows, ...map };
    render();
  }

  function updateIncrement(mins) {
    const m = Number(mins);
    if (![15, 30, 45, 60].includes(m)) return;
    const ts = LS.get(KEY_TIME, state.timeSettings);
    ts.incrementMin = m;
    LS.set(KEY_TIME, ts);
    render();
  }

  function rebuildAndRender() {
    rebuildFromDOM();
    render();
  }

  // ---------- Wire global ----------
  window.Scheduler = {
    render,
    addItem,
    removeItem,
    upsertItems,
    setDivisionWindows,
    updateIncrement,
    rebuildFromDOM: rebuildAndRender,
  };

  // ---------- Auto-bind to common app1 events (if present) ----------
  // If app1 dispatches a custom event after rebuilding the grid, listen & re-render.
  document.addEventListener("grid:rebuilt", () => {
    render();
  });

  // Initial render (after DOM ready)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();      const bunks = divisions[div]?.bunks || [];

      if (outside) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        td.className = "grey-cell";
        td.style.background = "#ddd";
        td.textContent = "—";
        tr.appendChild(td);
        return;
      }

      if (league) {
        const td = document.createElement("td");
        td.colSpan = bunks.length;
        td.style.background = divisions[div]?.color || "#4CAF50";
        td.style.color = "#fff";
        td.style.fontWeight = "600";
        const list = league.games
          .map((g) => `${g.teams[0]} vs ${g.teams[1]} (${g.sport})`)
          .join(" • ");
        td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;">${league.leagueName}</span></div>`;
        tr.appendChild(td);
      } else {
        bunks.forEach((b) => {
          const entry = scheduleAssignments[b]?.[i];
          const td = document.createElement("td");
          if (!entry) {
            tr.appendChild(td);
            return;
          }
          if (entry._fixed) {
            td.textContent = fieldLabel(entry.field);
            td.style.background = "#f1f1f1";
            td.style.fontWeight = "600";
          } else if (fieldLabel(entry.field) === "Special Activity Needed") {
            td.innerHTML = `<span style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
          } else if (entry.sport) {
            td.textContent = `${fieldLabel(entry.field)} – ${entry.sport}`;
          } else {
            td.textContent = fieldLabel(entry.field);
          }
          tr.appendChild(td);
        });
      }
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

// ===== Save/Init =====
function saveSchedule() {
  try {
    localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
    localStorage.setItem("leagueAssignments", JSON.stringify(window.leagueAssignments || {}));
  } catch (e) {
    console.error("Save schedule failed:", e);
  }
}
function reconcileOrRenderSaved() {
  try {
    window.scheduleAssignments = JSON.parse(localStorage.getItem("scheduleAssignments") || "{}") || {};
    window.leagueAssignments = JSON.parse(localStorage.getItem("leagueAssignments") || "{}") || {};
  } catch {}
  updateTable();
}
function initScheduleSystem() {
  try {
    reconcileOrRenderSaved();
  } catch (e) {
    console.error("Init error:", e);
    updateTable();
  }
}

window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", initScheduleSystem);
else initScheduleSystem();
