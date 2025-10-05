/******************************
 * app2.js – Camp Scheduler Engine
 ******************************/

// =================== Utility ===================

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getIncrement() {
  const el = document.getElementById("increment");
  return el ? parseInt(el.value, 10) : 30;
}

function spanLength() {
  const inc = getIncrement();
  return Math.max(1, Math.ceil(activityDuration / inc));
}

function activeForDivision(div, r) {
  const set = divisionActiveRows[div];
  return !!(set && set.has(r));
}

function makeUsageMap() {
  return {
    map: new Map(),
    isFree(n, r) {
      const set = this.map.get(n);
      return !(set && set.has(r));
    },
    reserve(n, r) {
      if (!this.map.has(n)) this.map.set(n, new Set());
      this.map.get(n).add(r);
    },
    reserveSpan(n, start, span) {
      for (let i = start; i < start + span && i < unifiedTimes.length; i++) {
        this.reserve(n, i);
      }
    }
  };
}

// =================== Main Generator ===================

function generateSchedule() {
  if (!unifiedTimes || unifiedTimes.length === 0) {
    alert("Add your times first.");
    return;
  }

  scheduleAssignments = {};
  for (const div of Object.values(divisions)) {
    for (const b of div.bunks) scheduleAssignments[b] = new Array(unifiedTimes.length).fill(null);
  }

  const span = spanLength();
  const usage = makeUsageMap();

  const availFields = fields.filter(f => f.available && f.activities?.length);
  const availSpecials = specialActivities.filter(s => s.available);

  const leagueRow = pickLeagueRow();

  // ============ Pass 1: Assign by row ============
  for (let r = 0; r < unifiedTimes.length; r++) {
    let activePairs = [];
    for (const d of availableDivisions) {
      if (!activeForDivision(d, r)) continue;
      for (const b of divisions[d].bunks) {
        if (!scheduleAssignments[b][r]) activePairs.push({ d, b });
      }
    }
    shuffle(activePairs);

    for (const { d, b } of activePairs) {
      if (leagueRow[d] === r) {
        putSpan(b, r, span, { label: "Leagues", type: "league", span });
        continue;
      }
      const ok = tryActivity(b, d, r, span, availFields, availSpecials, usage);
      if (!ok)
        putSpan(b, r, span, { label: "Free Play", type: "fallback", span });
    }
  }

  // ============ Pass 2: Fill holes ============
  fillBlanks(span, availFields, availSpecials, usage, leagueRow);

  renderSchedule();
}

// =================== League Rows ===================

function pickLeagueRow() {
  const out = {};
  const span = spanLength();
  for (const d of availableDivisions) {
    if (!leagues[d]?.enabled) continue;
    const act = Array.from(divisionActiveRows[d] || []);
    const starts = act.filter(r => {
      for (let i = r; i < r + span; i++) if (!activeForDivision(d, i)) return false;
      return true;
    });
    if (!starts.length) continue;
    out[d] = starts[Math.floor(Math.random() * starts.length)];
  }
  return out;
}

// =================== Placement ===================

function putSpan(b, start, span, data) {
  for (let r = start; r < start + span && r < unifiedTimes.length; r++) {
    const cell = { ...data, continuation: r > start, _skip: r > start };
    scheduleAssignments[b][r] = cell;
  }
}

function spanOK(d, start, span) {
  for (let i = start; i < start + span && i < unifiedTimes.length; i++)
    if (!activeForDivision(d, i)) return false;
  return true;
}

function spanFree(usage, name, start, span) {
  for (let i = start; i < start + span && i < unifiedTimes.length; i++)
    if (!usage.isFree(name, i)) return false;
  return true;
}

function tryActivity(b, d, r, span, fieldsA, specialsA, usage) {
  const opts = [];
  for (const f of fieldsA)
    for (const s of f.activities)
      opts.push({ type: "field", field: f.name, sport: s });
  for (const s of specialsA) opts.push({ type: "special", name: s.name });
  shuffle(opts);

  for (const o of opts) {
    if (!spanOK(d, r, span)) continue;
    const name = o.type === "field" ? `FIELD:${o.field}` : `SPECIAL:${o.name}`;
    if (!spanFree(usage, name, r, span)) continue;
    const label = o.type === "field" ? o.sport : o.name;
    putSpan(b, r, span, { label, type: o.type, field: o.field || null, span });
    usage.reserveSpan(name, r, span);
    return true;
  }
  return false;
}

// =================== Fill Blanks ===================

function fillBlanks(span, fieldsA, specialsA, usage, leagueRow) {
  for (const d of availableDivisions) {
    const div = divisions[d];
    for (const b of div.bunks) {
      for (let r = 0; r < unifiedTimes.length; r++) {
        if (!activeForDivision(d, r)) continue;
        if (scheduleAssignments[b][r]) continue;

        if (leagueRow[d] === r) {
          putSpan(b, r, span, { label: "Leagues", type: "league", span });
          continue;
        }

        const ok = tryActivity(b, d, r, span, fieldsA, specialsA, usage);
        if (!ok)
          putSpan(b, r, span, { label: "Free Play", type: "fallback", span });
      }
    }
  }
}

// =================== Render Table ===================

function renderSchedule() {
  const t = document.getElementById("scheduleTable");
  if (!t) return;
  t.innerHTML = "";

  const thead = document.createElement("thead");
  const trDiv = document.createElement("tr");
  const thTime = document.createElement("th");
  thTime.textContent = "Time";
  trDiv.appendChild(thTime);

  for (const d of availableDivisions) {
    const div = divisions[d];
    const th = document.createElement("th");
    th.textContent = d;
    th.colSpan = div.bunks.length;
    th.style.background = div.color;
    th.style.color = "white";
    trDiv.appendChild(th);
  }
  thead.appendChild(trDiv);

  const trB = document.createElement("tr");
  const blank = document.createElement("th");
  trB.appendChild(blank);
  for (const d of availableDivisions) {
    for (const b of divisions[d].bunks) {
      const th = document.createElement("th");
      th.textContent = b;
      trB.appendChild(th);
    }
  }
  thead.appendChild(trB);
  t.appendChild(thead);

  const tb = document.createElement("tbody");
  for (let r = 0; r < unifiedTimes.length; r++) {
    const tr = document.createElement("tr");
    const tdT = document.createElement("td");
    tdT.textContent = unifiedTimes[r].label;
    tdT.style.fontWeight = "bold";
    tr.appendChild(tdT);

    for (const d of availableDivisions) {
      const div = divisions[d];
      for (const b of div.bunks) {
        const cell = scheduleAssignments[b][r];
        if (cell && cell._skip) continue;
        const td = document.createElement("td");

        if (!activeForDivision(d, r)) {
          td.style.background = "#eee";
          td.textContent = "";
        } else if (!cell) {
          td.textContent = "—";
        } else {
          // merge vertical spans
          let spanR = 1;
          for (let k = r + 1; k < r + cell.span && k < unifiedTimes.length; k++) {
            const next = scheduleAssignments[b][k];
            if (next && next.continuation) spanR++;
          }
          if (spanR > 1) td.rowSpan = spanR;
          td.textContent = cell.label;
          if (cell.type === "league") td.style.fontWeight = "bold";
          if (cell.type === "field")
            td.title = `${cell.label} @ ${cell.field}`;
        }

        tr.appendChild(td);
      }
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb);
}

// =================== Expose ===================
window.generateSchedule = generateSchedule;

// =================== Initialization ===================

function initApp2() {
  // Ensure all base data exists
  if (!window.divisions) window.divisions = {};
  if (!window.availableDivisions) window.availableDivisions = [];
  if (!window.fields) window.fields = [];
  if (!window.specialActivities) window.specialActivities = [];
  if (!window.leagues) window.leagues = {};
  if (!window.unifiedTimes) window.unifiedTimes = [];
  if (!window.divisionActiveRows) window.divisionActiveRows = {};
  if (!window.scheduleAssignments) window.scheduleAssignments = {};

  // Attach generate button if it exists
  const genBtn = document.getElementById("generateBtn");
  if (genBtn) genBtn.onclick = generateSchedule;

  // Auto-load previous schedule if saved
  const saved = localStorage.getItem("scheduleAssignments");
  if (saved) {
    try {
      scheduleAssignments = JSON.parse(saved);
      renderSchedule();
    } catch (e) {
      console.error("Failed to load saved schedule:", e);
    }
  }
}

// Save schedule whenever generated
function saveScheduleToLocal() {
  localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
}

// Modify generateSchedule to auto-save after generation
const originalGenerateSchedule = generateSchedule;
generateSchedule = function() {
  originalGenerateSchedule();
  saveScheduleToLocal();
};

// Run init on page load
window.addEventListener("DOMContentLoaded", initApp2);
