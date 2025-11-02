/* app2.js
 * Daily schedule rendering & interactions
 * - Duration per activity (independent of grid increment)
 * - Rowspan-based multi-slot rendering
 * - Overlap prevention
 * - Grey-out times not applicable to a division/grade
 *
 * Exposes window.Scheduler with:
 *   - render()
 *   - addItem(item)
 *   - removeItem(id)
 *   - upsertItems(itemsArray)
 *   - setDivisionWindows(windowsByDivisionId)
 *   - updateIncrement(mins)
 *   - rebuildFromDOM()   // re-reads grid (rows/cols) and re-renders
 *
 * Required DOM assumptions:
 *   - Table container has id #scheduleTable (tbody cells have data-row & data-col)
 *   - Time grid rows are sequential 0..N-1 (built in app1.js)
 *   - Columns have stable keys in data-col (usually bunk ids)
 *
 * Required data (via localStorage or your own state singletons):
 *   - TIME_SETTINGS: { dayStart: "9:00 AM", dayEnd: "5:00 PM", incrementMin: 15 }
 *   - DIVISIONS: [{ id, name, color, window?: { start:"9:30 AM", end:"4:00 PM" } }, ...]
 *   - BUNKS: [{ id, name, divisionId }, ...]
 *   - FIELDS: optional
 *   - SCHEDULE_ITEMS: [{ id, label, bunkId, divisionId, fieldId?, start:"11:00 AM", durationMin:45, meta?:{field:"f7"} }, ...]
 *
 * Styling:
 *   Add to styles.css if not present:
 *     td.activity { vertical-align: middle; font-weight:600; border:2px solid rgba(0,0,0,.08); }
 *     td.continued { display:none; }
 *     td.greyed { background: repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 8px, #e5e7eb 8px, #e5e7eb 16px); color:#9ca3af; }
 *     td.conflict { outline: 2px dashed #ef4444; }
 */

(function () {
  // ---------- LocalStorage helpers ----------
  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  };

  // ---------- Keys (adjust if your project uses different names) ----------
  const KEY_TIME = "TIME_SETTINGS";
  const KEY_DIVS = "DIVISIONS";
  const KEY_BUNKS = "BUNKS";
  const KEY_FIELDS = "FIELDS";
  const KEY_ITEMS = "SCHEDULE_ITEMS";

  // ---------- State ----------
  const state = {
    timeSettings: LS.get(KEY_TIME, {
      dayStart: "9:00 AM",
      dayEnd: "5:00 PM",
      incrementMin: 15,
    }),
    divisions: LS.get(KEY_DIVS, []),
    bunks: LS.get(KEY_BUNKS, []),
    fields: LS.get(KEY_FIELDS, []),
    items: LS.get(KEY_ITEMS, []),

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
