
// =================================================================
// app1.js
//
// DIVISIONS UI & EDIT PANEL (FINALIZED THEME):
// - Left: division cards (pill + square chip + subline).
// - Right: Division Details card with:
//      • Header: colored dot + name, plus summary text
//      • Color selector pill
//      • Left section: Division Times (+ Schedule grid pill)
//      • Right section: Bunks in this Division (+ Add per division pill)
// - Bunks:
//      • Pills like mock
//      • Single-click = rename
//      • Double-click (within 260ms) = delete
// - Shared style helper keeps Setup tab visually consistent with Fields.
// - THEME: Modern Pro Camp (emerald primary, clean white cards).
// =================================================================

(function () {
  "use strict";

  // -------------------- State --------------------
  let bunks = [];
  let divisions = {}; // { divName:{ bunks:[], color, startTime, endTime } }
  let specialActivities = [];

  let availableDivisions = [];
  let selectedDivision = null;

  // Master list of all sports
  let allSports = [];
  const defaultSports = [
    "Baseball",
    "Basketball",
    "Football",
    "Hockey",
    "Kickball",
    "Lacrosse",
    "Newcomb",
    "Punchball",
    "Soccer",
    "Volleyball",
  ];

  // Skeleton template management
  let savedSkeletons = {};
  let skeletonAssignments = {}; // { "Monday": "templateName", "Default": "templateName" }

  // Modern Pro Camp accent palette
  const defaultColors = [
    "#00C896", // emerald primary
    "#0094FF", // electric blue
    "#FF7C3B", // blaze orange
    "#8A5DFF", // royal purple
    "#B5FF3F", // lime punch
    "#FF4D4D", // athletic red
    "#00A67C", // darker emerald
    "#6366F1", // indigo
    "#F97316", // warm orange
    "#10B981"  // teal/emerald variant
  ];
  let colorIndex = 0;

  // Expose to window
  window.divisions = divisions;
  window.availableDivisions = availableDivisions;

  // -------------------- Shared Theme Helpers --------------------
  function ensureSharedSetupStyles() {
    if (document.getElementById("setup-shared-styles")) return;

    const style = document.createElement("style");
    style.id = "setup-shared-styles";
    style.textContent = `
        /* ===== Global Setup / Detail Pane Shell (Modern Pro Camp) ===== */
        .detail-pane {
            border-radius: 18px;
            border: 1px solid #E5E7EB;
            padding: 18px 20px;
            background: linear-gradient(135deg, #F7F9FA 0%, #FFFFFF 55%, #F7F9FA 100%);
            min-height: 360px;
            box-shadow: 0 18px 40px rgba(15, 23, 42, 0.06);
        }

        /* Division list cards (left side) */
        .division-card {
            border-radius: 18px;
            border: 1px solid #E5E7EB;
            background: #FFFFFF;
            padding: 10px 16px;
            margin: 8px 0;
            box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
            cursor: pointer;
            transition:
                border-color 0.16s ease,
                box-shadow 0.16s ease,
                transform 0.08s ease,
                background-color 0.16s ease;
        }
        .division-card:hover {
            box-shadow: 0 12px 26px rgba(15, 23, 42, 0.12);
            transform: translateY(-1px);
            background-color: #F9FAFB;
        }
        .division-card.selected {
            border-color: #00C896;
            box-shadow: 0 0 0 1px rgba(0, 200, 150, 0.55);
            background: radial-gradient(circle at top left, #ECFDF5 0, #FFFFFF 65%);
        }

        .division-card-top {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 4px;
        }
        .division-pill {
            padding: 4px 16px;
            border-radius: 999px;
            color: #FFFFFF;
            font-weight: 600;
            font-size: 0.9rem;
            min-width: 32px;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 10px rgba(15, 23, 42, 0.22);
        }
        .division-color-chip-list {
            width: 22px;
            height: 22px;
            border-radius: 6px;
            border: 1px solid rgba(15, 23, 42, 0.12);
            box-shadow: 0 2px 6px rgba(15, 23, 42, 0.15);
        }
        .division-card-subline {
            font-size: 0.8rem;
            color: #6B7280;
        }

        /* Division detail inner layout (flattened to avoid triple-layer look) */
        .division-edit-shell {
            padding: 4px 0 0;
            border-radius: 16px;
            border: none;
            background: transparent;
            box-shadow: none;
        }
        .division-edit-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding-bottom: 10px;
            border-bottom: 1px solid #E5E7EB;
            margin-bottom: 14px;
        }
        .division-header-left {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            font-size: 0.98rem;
            color: #111827;
        }
        .division-header-left .division-name {
            cursor: text;
        }
        .division-status-dot {
            width: 11px;
            height: 11px;
            border-radius: 999px;
            background: #00C896;
            box-shadow: 0 0 0 4px rgba(0, 200, 150, 0.25);
        }
        .division-header-summary {
            font-size: 0.8rem;
            color: #6B7280;
            text-align: right;
            white-space: nowrap;
        }

        .division-edit-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            margin-top: 6px;
        }

        /* Mini cards = second layer (times / bunks) */
        .division-mini-card {
            flex: 1 1 280px;
            border-radius: 16px;
            background: #FFFFFF;
            border: 1px solid #E5E7EB;
            padding: 12px 14px 14px;
            box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
        }
        .division-mini-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            padding-bottom: 6px;
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: #6B7280;
            font-weight: 600;
            border-bottom: 1px solid rgba(148, 163, 184, 0.4);
        }
        .division-mini-pill {
            padding: 4px 12px;
            border-radius: 999px;
            background: #ECFDF5;
            color: #047857;
            font-size: 0.7rem;
            border: none;
            cursor: default;
            font-weight: 500;
            box-shadow: 0 4px 10px rgba(16, 185, 129, 0.35);
        }
        .division-mini-pill:disabled {
            opacity: 0.8;
        }
        .division-mini-help {
            margin: 0 0 10px;
            font-size: 0.78rem;
            color: #6B7280;
            max-width: 340px;
        }

        /* Color row for division detail */
        .division-color-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 6px 0 16px;
            font-size: 0.8rem;
            color: #4B5563;
        }
        .division-color-row input[type="color"] {
            -webkit-appearance: none;
            appearance: none;
            width: 68px;
            height: 26px;
            padding: 0;
            border-radius: 999px;
            border: 1px solid #E5E7EB;
            background: #FFFFFF;
            overflow: hidden;
            box-shadow: 0 4px 10px rgba(15, 23, 42, 0.12);
        }
        .division-color-row input[type="color"]::-webkit-color-swatch {
            border: none;
            border-radius: 999px;
            padding: 0;
        }
        .division-color-row input[type="color"]::-moz-color-swatch {
            border: none;
            border-radius: 999px;
        }

        /* Bunk pills */
        .division-bunk-pill {
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid #D1D5DB;
            background: #FFFFFF;
            color: #374151;
            font-size: 0.8rem;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 28px;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1);
            transition:
                background-color 0.12s ease,
                box-shadow 0.12s ease,
                transform 0.06s ease;
        }
        .division-bunk-pill:hover {
            background-color: #F3F4F6;
            box-shadow: 0 3px 8px rgba(15, 23, 42, 0.14);
            transform: translateY(-0.5px);
        }

        /* Muted text helper (in case not defined globally) */
        .muted {
            color: #6B7280;
            font-size: 0.86rem;
        }
    `;
    document.head.appendChild(style);
  }

  // -------------------- Helpers --------------------
  function makeEditable(el, save) {
    el.ondblclick = (e) => {
      e.stopPropagation();
      const old = el.textContent;
      const input = document.createElement("input");
      input.type = "text";
      input.value = old;
      el.replaceWith(input);
      input.focus();
      function done() {
        const val = input.value.trim();
        if (val && val !== old) save(val);
        el.textContent = val || old;
        input.replaceWith(el);
      }
      input.onblur = done;
      input.onkeyup = (e2) => {
        if (e2.key === "Enter") done();
      };
    };
  }

  function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am") || s.endsWith("pm")) {
      mer = s.endsWith("am") ? "am" : "pm";
      s = s.replace(/am|pm/g, "").trim();
    }

    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (Number.isNaN(hh) || Number.isNaN(mm) || mm < 0 || mm > 59) return null;

    if (!mer) return null;

    if (hh === 12) hh = mer === "am" ? 0 : 12;
    else if (mer === "pm") hh += 12;

    return hh * 60 + mm;
  }

  // Sort helper: "Bunk 1, Bunk 2, Bunk 10" numeric order
  function compareBunks(a, b) {
    const sa = String(a);
    const sb = String(b);
    const re = /(\d+)/;
    const ma = sa.match(re);
    const mb = sb.match(re);

    if (ma && mb) {
      const na = parseInt(ma[1], 10);
      const nb = parseInt(mb[1], 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) {
        return na - nb;
      }
    }
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
  }

  function sortBunksInPlace(arr) {
    if (!Array.isArray(arr)) return;
    arr.sort(compareBunks);
  }

  function renameBunkEverywhere(oldName, newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;

    const exists = bunks.some(
      (b) => b.toLowerCase() === trimmed.toLowerCase() && b !== oldName
    );
    if (exists) {
      alert("Another bunk with this name already exists.");
      return;
    }

    const idx = bunks.indexOf(oldName);
    if (idx !== -1) bunks[idx] = trimmed;

    Object.values(divisions).forEach((d) => {
      const bi = d.bunks.indexOf(oldName);
      if (bi !== -1) d.bunks[bi] = trimmed;
      sortBunksInPlace(d.bunks);
    });

    if (window.scheduleAssignments && window.scheduleAssignments[oldName]) {
      window.scheduleAssignments[trimmed] = window.scheduleAssignments[oldName];
      delete window.scheduleAssignments[oldName];
      window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
    }

    saveData();
    renderDivisionDetailPane();
    window.updateTable?.();
  }

  // -------------------- Bunks --------------------
  function addBunkToDivision(divName, bunkName) {
    if (!divName || !bunkName) return;
    const cleanDiv = String(divName).trim();
    const cleanBunk = String(bunkName).trim();
    if (!cleanDiv || !cleanBunk) return;

    if (!bunks.includes(cleanBunk)) {
      bunks.push(cleanBunk);
    }

    const div = divisions[cleanDiv];
    if (div && !div.bunks.includes(cleanBunk)) {
      div.bunks.push(cleanBunk);
      sortBunksInPlace(div.bunks);
    }

    saveData();
    renderDivisionDetailPane();
    window.updateTable?.();
  }

  // -------------------- Divisions --------------------
  function addDivision() {
    const i = document.getElementById("divisionInput");
    if (!i) return;
    const raw = i.value.trim();
    if (!raw) return;

    const name = raw;
    if (availableDivisions.includes(name)) {
      alert("That division already exists.");
      i.value = "";
      return;
    }

    const color = defaultColors[colorIndex % defaultColors.length];
    colorIndex++;

    availableDivisions.push(name);
    window.availableDivisions = availableDivisions;

    divisions[name] = {
      bunks: [],
      color,
      startTime: "",
      endTime: "",
    };
    window.divisions = divisions;

    selectedDivision = name;

    i.value = "";
    saveData();
    setupDivisionButtons();
    renderDivisionDetailPane();
    window.initLeaguesTab?.();
    window.updateTable?.();
  }

  /**
   * LEFT SIDE: division cards matching screenshot.
   */
  function setupDivisionButtons() {
    const cont = document.getElementById("divisionButtons");
    if (!cont) return;
    cont.innerHTML = "";

    if (!availableDivisions || availableDivisions.length === 0) {
      cont.innerHTML = `<p class="muted">No divisions created yet. Add one above.</p>`;
      renderDivisionDetailPane();
      return;
    }

    availableDivisions.forEach((name) => {
      const obj = divisions[name];
      if (!obj) {
        console.warn(
          `Division "${name}" exists in availableDivisions but not in divisions object.`
        );
        return;
      }

      const card = document.createElement("div");
      card.className = "division-card";
      if (selectedDivision === name) card.classList.add("selected");

      card.onclick = () => {
        selectedDivision = name;
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
      };

      const topRow = document.createElement("div");
      topRow.className = "division-card-top";

      const pill = document.createElement("div");
      pill.className = "division-pill";
      pill.style.backgroundColor = obj.color || "#00C896";
      pill.textContent = name;

      const chip = document.createElement("div");
      chip.className = "division-color-chip-list";
      chip.style.backgroundColor = obj.color || "#00C896";

      topRow.appendChild(pill);
      topRow.appendChild(chip);
      card.appendChild(topRow);

      const sub = document.createElement("div");
      sub.className = "division-card-subline";
      const bunkCount = (obj.bunks || []).length;
      const times =
        obj.startTime && obj.endTime
          ? `${obj.startTime} \u2013 ${obj.endTime}`
          : "Times not set";
      sub.textContent = `${bunkCount} bunks \u2022 ${times}`;
      card.appendChild(sub);

      cont.appendChild(card);
    });

    renderDivisionDetailPane();
  }

  /**
   * RIGHT SIDE: detail pane – styled to match mock edit section.
   */
  function renderDivisionDetailPane() {
    const pane = document.getElementById("division-detail-pane");
    if (!pane) return;

    pane.innerHTML = "";

    if (!selectedDivision || !divisions[selectedDivision]) {
      pane.innerHTML = `
            <p class="muted">
                Click a division on the left to set its <strong>times</strong>,
                color, and <strong>bunks</strong>.
            </p>
        `;
      return;
    }

    const divObj = divisions[selectedDivision];

    // --- Top header row: title + delete button (outside inner shell) ---
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.borderBottom = "2px solid #E5E7EB";
    header.style.paddingBottom = "8px";
    header.style.marginBottom = "10px";
    header.style.columnGap = "12px";

    const title = document.createElement("h3");
    title.style.margin = "0";
    title.style.fontSize = "1rem";
    title.style.fontWeight = "600";
    title.style.color = "#111827";
    title.textContent = "Division Details & Bunks";
    header.appendChild(title);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete Division";
    deleteBtn.style.background = "#FFFFFF";
    deleteBtn.style.color = "#DC2626";
    deleteBtn.style.border = "1px solid #FECACA";
    deleteBtn.style.padding = "6px 16px";
    deleteBtn.style.borderRadius = "999px";
    deleteBtn.style.cursor = "pointer";
    deleteBtn.style.fontWeight = "600";
    deleteBtn.style.boxShadow = "0 4px 10px rgba(220,38,38,0.12)";
    deleteBtn.style.fontSize = "0.85rem";
    deleteBtn.onmouseenter = () => {
      deleteBtn.style.background = "#FEE2E2";
    };
    deleteBtn.onmouseleave = () => {
      deleteBtn.style.background = "#FFFFFF";
    };
    deleteBtn.onclick = () => {
      if (
        !confirm(
          `Delete division "${selectedDivision}"? Bunks remain globally but are removed from this division.`
        )
      ) {
        return;
      }
      const name = selectedDivision;
      delete divisions[name];
      const idx = availableDivisions.indexOf(name);
      if (idx !== -1) availableDivisions.splice(idx, 1);
      selectedDivision = availableDivisions[0] || null;
      window.divisions = divisions;
      window.availableDivisions = availableDivisions;
      saveData();
      setupDivisionButtons();
      renderDivisionDetailPane();
      window.initLeaguesTab?.();
      window.updateTable?.();
    };

    header.appendChild(deleteBtn);
    pane.appendChild(header);

    // --- Color row ---
    const colorRow = document.createElement("div");
    colorRow.className = "division-color-row";

    const colorLabel = document.createElement("span");
    colorLabel.textContent = "Division color";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = divObj.color || "#00C896";
    colorInput.oninput = (e) => {
      divObj.color = e.target.value;
      saveData();
      setupDivisionButtons();     // update left list
      renderDivisionDetailPane(); // refresh dot + summary
      window.updateTable?.();
    };

    colorRow.appendChild(colorLabel);
    colorRow.appendChild(colorInput);
    pane.appendChild(colorRow);

    // --- Main inner shell: flattened container for header + mini cards ---
    const shell = document.createElement("div");
    shell.className = "division-edit-shell";
    pane.appendChild(shell);

    // Header inside shell: colored dot + division name, summary on right
    const innerHeader = document.createElement("div");
    innerHeader.className = "division-edit-header";

    const leftSide = document.createElement("div");
    leftSide.className = "division-header-left";

    const dot = document.createElement("span");
    dot.className = "division-status-dot";
    const dotColor = divObj.color || "#00C896";
    dot.style.backgroundColor = dotColor;
    dot.style.boxShadow = `0 0 0 4px ${dotColor}33`;

    const titleName = document.createElement("span");
    titleName.textContent = selectedDivision;
    titleName.className = "division-name";

    // Allow rename by double-clicking the name here
    makeEditable(titleName, (newName) => {
      const trimmed = newName.trim();
      const old = selectedDivision;
      if (!trimmed || trimmed === old) return;
      if (divisions[trimmed]) {
        alert("A division with this name already exists.");
        return;
      }

      divisions[trimmed] = divisions[old];
      delete divisions[old];

      const idx = availableDivisions.indexOf(old);
      if (idx !== -1) availableDivisions[idx] = trimmed;

      selectedDivision = trimmed;
      window.divisions = divisions;
      window.availableDivisions = availableDivisions;
      saveData();
      setupDivisionButtons();
      renderDivisionDetailPane();
      window.initLeaguesTab?.();
      window.updateTable?.();
    });

    leftSide.appendChild(dot);
    leftSide.appendChild(titleName);

    const rightSide = document.createElement("div");
    rightSide.className = "division-header-summary";
    const bunkCount = (divObj.bunks || []).length;
    const timesSummary =
      divObj.startTime && divObj.endTime
        ? `${divObj.startTime} \u2013 ${divObj.endTime}`
        : "Times not set";
    rightSide.textContent = `${bunkCount + " bunk" + (bunkCount === 1 ? "" : "s")} \u2022 ${timesSummary}`;

    innerHeader.appendChild(leftSide);
    innerHeader.appendChild(rightSide);
    shell.appendChild(innerHeader);

    // --- Grid with two mini sections (Times + Bunks) ---
    const grid = document.createElement("div");
    grid.className = "division-edit-grid";
    shell.appendChild(grid);

    // ===== MINI SECTION 1: DIVISION TIMES =====
    const timeCard = document.createElement("div");
    timeCard.className = "division-mini-card";

    const timeHeader = document.createElement("div");
    timeHeader.className = "division-mini-header";
    const timeTitle = document.createElement("span");
    timeTitle.textContent = "Division Times";

    const schedBtn = document.createElement("button");
    schedBtn.className = "division-mini-pill";
    schedBtn.textContent = "Schedule grid";
    schedBtn.disabled = true; // visual only for now

    timeHeader.appendChild(timeTitle);
    timeHeader.appendChild(schedBtn);
    timeCard.appendChild(timeHeader);

    const timeHelp = document.createElement("p");
    timeHelp.className = "division-mini-help";
    timeHelp.textContent =
      "Set the daily time window this division is in camp. Used as the base for your schedule grid.";
    timeCard.appendChild(timeHelp);

    const timeForm = document.createElement("div");
    timeForm.style.display = "flex";
    timeForm.style.alignItems = "center";
    timeForm.style.gap = "8px";
    timeForm.style.marginTop = "4px";

    const startInput = document.createElement("input");
    startInput.type = "text";
    startInput.placeholder = "11:00am";
    startInput.value = divObj.startTime || "";
    startInput.style.width = "110px";
    startInput.style.padding = "4px 8px";
    startInput.style.borderRadius = "999px";
    startInput.style.border = "1px solid #D1D5DB";
    startInput.style.fontSize = "0.85rem";

    const toLabel = document.createElement("span");
    toLabel.textContent = "to";
    toLabel.style.fontSize = "0.8rem";
    toLabel.style.color = "#6B7280";

    const endInput = document.createElement("input");
    endInput.type = "text";
    endInput.placeholder = "4:30pm";
    endInput.value = divObj.endTime || "";
    endInput.style.width = "110px";
    endInput.style.padding = "4px 8px";
    endInput.style.borderRadius = "999px";
    endInput.style.border = "1px solid #D1D5DB";
    endInput.style.fontSize = "0.85rem";

    const updateBtn = document.createElement("button");
    updateBtn.textContent = "Update";
    updateBtn.style.padding = "5px 14px";
    updateBtn.style.borderRadius = "999px";
    updateBtn.style.border = "none";
    updateBtn.style.background = "#00C896";
    updateBtn.style.color = "#FFFFFF";
    updateBtn.style.fontSize = "0.85rem";
    updateBtn.style.fontWeight = "600";
    updateBtn.style.cursor = "pointer";
    updateBtn.style.boxShadow = "0 4px 10px rgba(0, 200, 150, 0.35)";
    updateBtn.onmouseenter = () => {
      updateBtn.style.background = "#00A67C";
    };
    updateBtn.onmouseleave = () => {
      updateBtn.style.background = "#00C896";
    };

    updateBtn.onclick = () => {
      const newStart = startInput.value.trim();
      const newEnd = endInput.value.trim();

      const startMin = parseTimeToMinutes(newStart);
      const endMin = parseTimeToMinutes(newEnd);

      if (startMin == null || endMin == null) {
        alert("Invalid time format. Use '9:00am' or '2:30pm' with am/pm.");
        return;
      }
      if (endMin <= startMin) {
        alert("End time must be after start time.");
        return;
      }

      divObj.startTime = newStart;
      divObj.endTime = newEnd;
      saveData();
      setupDivisionButtons();
      renderDivisionDetailPane();

      if (document.getElementById("master-scheduler")?.classList.contains("active")) {
        window.initMasterScheduler?.();
      } else if (
        document.getElementById("daily-adjustments")?.classList.contains("active")
      ) {
        window.initDailyAdjustments?.();
      }
    };

    timeForm.appendChild(startInput);
    timeForm.appendChild(toLabel);
    timeForm.appendChild(endInput);
    timeForm.appendChild(updateBtn);
    timeCard.appendChild(timeForm);
    grid.appendChild(timeCard);

    // ===== MINI SECTION 2: BUNKS IN THIS DIVISION =====
    const bunksCard = document.createElement("div");
    bunksCard.className = "division-mini-card";

    const bunksHeader = document.createElement("div");
    bunksHeader.className = "division-mini-header";
    const bunksTitle = document.createElement("span");
    bunksTitle.textContent = "Bunks in this Division";

    const addPerBtn = document.createElement("button");
    addPerBtn.className = "division-mini-pill";
    addPerBtn.textContent = "Add per division";
    addPerBtn.disabled = true; // visual only

    bunksHeader.appendChild(bunksTitle);
    bunksHeader.appendChild(addPerBtn);
    bunksCard.appendChild(bunksHeader);

    const bunksHelp = document.createElement("p");
    bunksHelp.className = "division-mini-help";
    bunksHelp.textContent =
      "Add bunks directly to this division, or remove existing bunks with a click.";
    bunksCard.appendChild(bunksHelp);

    const bunkList = document.createElement("div");
    bunkList.style.marginTop = "6px";
    bunkList.style.display = "flex";
    bunkList.style.flexWrap = "wrap";
    bunkList.style.gap = "6px";

    if (!divObj.bunks || divObj.bunks.length === 0) {
      const msg = document.createElement("p");
      msg.className = "muted";
      msg.style.margin = "4px 0 0 0";
      msg.textContent = "No bunks assigned yet. Add one below.";
      bunksCard.appendChild(msg);
    } else {
      const sorted = divObj.bunks.slice().sort(compareBunks);
      sorted.forEach((bunkName) => {
        const pill = document.createElement("span");
        pill.className = "division-bunk-pill";
        pill.textContent = bunkName;

        let clickTimer = null;
        const clickDelay = 260;

        function startInlineEdit() {
          const old = bunkName;
          const input = document.createElement("input");
          input.type = "text";
          input.value = bunkName;
          input.style.minWidth = "60px";
          input.style.padding = "3px 8px";
          input.style.borderRadius = "999px";
          input.style.border = "1px solid #D1D5DB";
          input.style.fontSize = "0.8rem";

          const parent = pill.parentNode;
          if (!parent) return;
          parent.replaceChild(input, pill);
          input.focus();

          function finish() {
            const val = input.value.trim();
            if (val && val !== old) {
              renameBunkEverywhere(old, val);
            } else {
              renderDivisionDetailPane();
            }
          }

          input.onblur = finish;
          input.onkeyup = (e) => {
            if (e.key === "Enter") finish();
            if (e.key === "Escape") renderDivisionDetailPane();
          };
        }

        pill.onclick = (e) => {
          e.stopPropagation();
          if (clickTimer) {
            // second click -> delete
            clearTimeout(clickTimer);
            clickTimer = null;

            const idx = divObj.bunks.indexOf(bunkName);
            if (idx !== -1) divObj.bunks.splice(idx, 1);
            saveData();
            renderDivisionDetailPane();
            window.updateTable?.();
          } else {
            // wait for potential second click
            clickTimer = setTimeout(() => {
              clickTimer = null;
              startInlineEdit();
            }, clickDelay);
          }
        };

        bunkList.appendChild(pill);
      });
    }

    bunkList.style.marginBottom = "8px";
    bunksCard.appendChild(bunkList);

    // "Add bunk" row
    const addRow = document.createElement("div");
    addRow.style.marginTop = "10px";
    addRow.style.display = "flex";
    addRow.style.gap = "6px";

    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Add bunk to this division (e.g., 5A)";
    addInput.style.flex = "1";
    addInput.style.padding = "5px 10px";
    addInput.style.borderRadius = "999px";
    addInput.style.border = "1px solid #D1D5DB";
    addInput.style.fontSize = "0.86rem";

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.style.padding = "5px 14px";
    addBtn.style.borderRadius = "999px";
    addBtn.style.border = "none";
    addBtn.style.background = "#00C896";
    addBtn.style.color = "#FFFFFF";
    addBtn.style.fontSize = "0.85rem";
    addBtn.style.fontWeight = "600";
    addBtn.style.cursor = "pointer";
    addBtn.style.boxShadow = "0 4px 10px rgba(0, 200, 150, 0.35)";
    addBtn.onmouseenter = () => {
      addBtn.style.background = "#00A67C";
    };
    addBtn.onmouseleave = () => {
      addBtn.style.background = "#00C896";
    };

    addBtn.onclick = () => {
      const name = addInput.value.trim();
      if (!name) return;
      addBunkToDivision(selectedDivision, name);
      addInput.value = "";
    };

    addInput.onkeyup = (e) => {
      if (e.key === "Enter") {
        const name = addInput.value.trim();
        if (!name) return;
        addBunkToDivision(selectedDivision, name);
        addInput.value = "";
      }
    };

    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    bunksCard.appendChild(addRow);

    grid.appendChild(bunksCard);
  }

  // -------------------- Persistence --------------------
  function saveData() {
    const app1Data = window.loadGlobalSettings?.().app1 || {};
    const data = {
      ...app1Data,
      bunks,
      divisions,
      availableDivisions,
      selectedDivision,
      allSports,
      savedSkeletons,
      skeletonAssignments,
      specialActivities,
    };
    window.saveGlobalSettings?.("app1", data);
  }

  function loadData() {
    const data = window.loadGlobalSettings?.().app1 || {};
    try {
      bunks = data.bunks || [];
      divisions = data.divisions || {};
      specialActivities = data.specialActivities || [];

      Object.keys(divisions).forEach((divName) => {
        divisions[divName].startTime = divisions[divName].startTime || "";
        divisions[divName].endTime = divisions[divName].endTime || "";
        divisions[divName].bunks = divisions[divName].bunks || [];
        sortBunksInPlace(divisions[divName].bunks);
        divisions[divName].color = divisions[divName].color || defaultColors[0];
      });

      availableDivisions =
        data.availableDivisions && Array.isArray(data.availableDivisions)
          ? data.availableDivisions.slice()
          : Object.keys(divisions);

      window.divisions = divisions;
      window.availableDivisions = availableDivisions;
      selectedDivision = data.selectedDivision || availableDivisions[0] || null;

      if (data.allSports && Array.isArray(data.allSports)) {
        allSports = data.allSports;
      } else {
        allSports = [...defaultSports];
      }

      savedSkeletons = data.savedSkeletons || {};
      skeletonAssignments = data.skeletonAssignments || {};
    } catch (e) {
      console.error("Error loading app1 data:", e);
    }
  }

  // -------------------- Init --------------------
  function initApp1() {
    ensureSharedSetupStyles();

    const addDivisionBtn = document.getElementById("addDivisionBtn");
    if (addDivisionBtn) addDivisionBtn.onclick = addDivision;

    const divisionInput = document.getElementById("divisionInput");
    if (divisionInput) {
      divisionInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") addDivision();
      });
    }

    loadData();

    const detailPane = document.getElementById("division-detail-pane");
    if (detailPane) {
      detailPane.classList.add("detail-pane");
      detailPane.style.marginTop = "8px";
    }

    setupDivisionButtons();
    renderDivisionDetailPane();
  }
  window.initApp1 = initApp1;

  // Expose some helpers
  window.getDivisions = () => divisions;

  // Sports
  window.getAllGlobalSports = function () {
    return (allSports || []).slice().sort();
  };
  window.addGlobalSport = function (sportName) {
    if (!sportName) return;
    const s = sportName.trim();
    if (s && !allSports.find((sp) => sp.toLowerCase() === s.toLowerCase())) {
      allSports.push(s);
      saveData();
    }
  };

  // Skeletons
  window.getSavedSkeletons = function () {
    return savedSkeletons || {};
  };
  window.saveSkeleton = function (name, skeletonData) {
    if (!name || !skeletonData) return;
    savedSkeletons[name] = skeletonData;
    saveData();
  };
  window.deleteSkeleton = function (name) {
    if (!name) return;
    delete savedSkeletons[name];
    Object.keys(skeletonAssignments).forEach((day) => {
      if (skeletonAssignments[day] === name) {
        delete skeletonAssignments[day];
      }
    });
    saveData();
  };
  window.getSkeletonAssignments = function () {
    return skeletonAssignments || {};
  };
  window.saveSkeletonAssignments = function (assignments) {
    if (!assignments) return;
    skeletonAssignments = assignments;
    saveData();
  };

  // Special activities
  window.getGlobalSpecialActivities = function () {
    return specialActivities;
  };
  window.saveGlobalSpecialActivities = function (updatedActivities) {
    specialActivities = updatedActivities;
    saveData();
  };

  // Keep helper name for other modules
  window.addDivisionBunk = addBunkToDivision;
})();
