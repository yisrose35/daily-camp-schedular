// =================================================================
// app1.js — MERGED: Beta Camper Roster + Published SyncSpine
//
// THEME: Modern Pro Camp (Emerald/White)
// FEATURES:
// - Bulk Import with Camper Names OR Counts
// - Double-click bunk to DELETE
// - Wider inputs for bunk editing
// - Sports Rules modal
// - SyncSpine integration with global_authority.js
// =================================================================
(function () {
"use strict";
console.log("📋 app1.js loaded");

function syncSpine() {
  window.setGlobalDivisions?.(structuredClone(divisions));
  window.setGlobalBunks?.(structuredClone(bunks));
}

// -------------------- State --------------------
let bunks = [];
let divisions = {};
let specialActivities = [];
let availableDivisions = [];
let selectedDivision = null;

// Metadata
let bunkMetaData = {};
let sportMetaData = {};

// Master list of all sports
let allSports = [];
const defaultSports = [
    "Baseball","Basketball","Football","Hockey","Kickball",
    "Lacrosse","Newcomb","Punchball","Soccer","Volleyball"
];

// Skeleton template management
let savedSkeletons = {};
let skeletonAssignments = {};

// Modern Pro Camp accent palette
const defaultColors = [
    "#00C896", "#0094FF", "#FF7C3B", "#8A5DFF", "#B5FF3F",
    "#FF4D4D", "#00A67C", "#6366F1", "#F97316", "#10B981"
];
let colorIndex = 0;

// Expose to window
window.divisions = divisions;
window.availableDivisions = availableDivisions;
window.getBunkMetaData = () => bunkMetaData;
window.getSportMetaData = () => sportMetaData;

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
            transition: all 0.16s ease;
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
        /* Division detail inner layout */
        .division-edit-shell {
            padding: 4px 0 0;
            border-radius: 16px;
            background: transparent;
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
        /* Mini cards */
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
        .division-mini-help {
            margin: 0 0 10px;
            font-size: 0.78rem;
            color: #6B7280;
            max-width: 340px;
        }
        /* Color row */
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
            gap: 6px;
            min-width: 28px;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1);
            transition: all 0.12s ease;
            user-select: none;
        }
        .division-bunk-pill:hover {
            background-color: #F3F4F6;
            box-shadow: 0 3px 8px rgba(15, 23, 42, 0.14);
            transform: translateY(-0.5px);
        }
        .bunk-size-badge {
            background: #ECFDF5;
            color: #047857;
            border-radius: 6px;
            padding: 1px 5px;
            font-size: 0.7rem;
            font-weight: 600;
            border: 1px solid #A7F3D0;
        }
        /* Inline Edit Form */
        .bunk-edit-form {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 3px 6px;
            border-radius: 999px;
            border: 1px solid #00C896;
            background: #FFFFFF;
            box-shadow: 0 2px 8px rgba(0,200,150,0.15);
        }
        .bunk-edit-input {
            border: 1px solid #E5E7EB;
            outline: none;
            padding: 3px 6px;
            width: 80px;
            font-size: 0.85rem;
            border-radius: 4px;
        }
        .bunk-edit-size {
            width: 65px;
            border: 1px solid #E5E7EB;
            border-radius: 4px;
            text-align: center;
            font-size: 0.85rem;
            padding: 3px 2px;
        }
        .bunk-edit-save {
            background: #00C896;
            color: white;
            border: none;
            border-radius: 50%;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8rem;
            cursor: pointer;
            flex-shrink: 0;
        }
        .bunk-edit-save:hover {
            background: #00A67C;
        }
        /* Bulk Import */
        .bulk-card {
            border: 1px solid #E5E7EB;
            border-radius: 16px;
            padding: 18px 24px;
            background: #FFFFFF;
            box-shadow: 0 4px 14px rgba(0,0,0,0.04);
            margin-bottom: 24px;
            width: 100%;
            box-sizing: border-box;
        }
        /* Sports Modal */
        .sports-modal-overlay {
            position: fixed; top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.4); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
            backdrop-filter: blur(2px);
        }
        .sports-modal {
            background: white;
            width: 400px; max-height: 80vh;
            border-radius: 16px; padding: 24px;
            overflow-y: auto;
            box-shadow: 0 20px 50px rgba(0,0,0,0.2);
        }
        .sports-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #F3F4F6;
        }
        .sport-cap-input {
            width: 60px;
            padding: 4px;
            border: 1px solid #D1D5DB;
            border-radius: 6px;
            text-align: center;
        }
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
        input.onkeyup = (ev) => {
            if (ev.key === "Enter") done();
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
    if (mer) {
        if (hh === 12) hh = mer === "am" ? 0 : 12;
        else if (mer === "pm") hh += 12;
    }
    return hh * 60 + mm;
}

function compareBunks(a, b) {
    const sa = String(a);
    const sb = String(b);
    const re = /(\d+)/;
    const ma = sa.match(re);
    const mb = sb.match(re);
    if (ma && mb) {
        const na = parseInt(ma[1], 10);
        const nb = parseInt(mb[1], 10);
        if (na !== nb) return na - nb;
    }
    return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}

function sortBunksInPlace(arr) {
    if (!Array.isArray(arr)) return;
    arr.sort(compareBunks);
}

function renameBunkEverywhere(oldName, newName, newSize) {
    const n = newName.trim();
    if (!n) return;
    const sizeVal = parseInt(newSize) || 0;
    // Only size changed
    if (n === oldName) {
        if (!bunkMetaData[n]) bunkMetaData[n] = {};
        bunkMetaData[n].size = sizeVal;
        saveData();
        renderDivisionDetailPane();
        window.updateTable?.();
        return;
    }
    const exists = bunks.some(b => b.toLowerCase() === n.toLowerCase() && b !== oldName);
    if (exists) {
        alert("Bunk name already exists.");
        return;
    }
    const idx = bunks.indexOf(oldName);
    if (idx !== -1) bunks[idx] = n;
    Object.values(divisions).forEach((d) => {
        const bi = d.bunks.indexOf(oldName);
        if (bi !== -1) d.bunks[bi] = n;
        sortBunksInPlace(d.bunks);
    });
    if (window.scheduleAssignments && window.scheduleAssignments[oldName]) {
        window.scheduleAssignments[n] = window.scheduleAssignments[oldName];
        delete window.scheduleAssignments[oldName];
        window.saveCurrentDailyData?.("scheduleAssignments", window.scheduleAssignments);
    }
    bunkMetaData[n] = { size: sizeVal };
    delete bunkMetaData[oldName];
    saveData();
    renderDivisionDetailPane();
    window.updateTable?.();
}

// -------------------- CSV / Bulk Logic (WITH CAMPER NAMES SUPPORT) --------------------
function downloadTemplate() {
    let csv = "Division,Bunk Name,Camper Name OR Count\n";
    if (availableDivisions.length === 0) {
        csv += "Junior,Bunk 1,12\nJunior,Bunk 2,Moshe Cohen\nSenior,Bunk A,David Levy\n";
    } else {
        availableDivisions.forEach(div => {
            const d = divisions[div];
            if (d.bunks.length > 0) {
                d.bunks.forEach(b => {
                    csv += `"${div}","${b}",(Enter Name or Count)\n`;
                });
            } else {
                csv += `"${div}","",\n`;
            }
        });
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.setAttribute("hidden", "");
    a.href = url;
    a.download = "camp_roster_template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function handleBulkImport(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const text = e.target.result;
        const lines = text.split("\n");
        let addedDivs = 0, addedBunks = 0, updatedSizes = 0, addedCampers = 0;
        
        // Load existing roster
        const globalSettings = window.loadGlobalSettings?.() || {};
        const app1Data = globalSettings.app1 || {};
        const camperRoster = app1Data.camperRoster || {};
        
        // Count bunks if importing names
        const bunkCounts = {};
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(",").map(s => s.replace(/^"|"$/g, "").trim());
            if (parts.length < 2) continue;
            const divName = parts[0];
            const bunkName = parts[1];
            const thirdCol = parts[2]; // Count or Name
            
            if (divName) {
                // Add Div
                if (!availableDivisions.includes(divName)) {
                    availableDivisions.push(divName);
                    divisions[divName] = {
                        bunks: [],
                        color: defaultColors[colorIndex++ % defaultColors.length]
                    };
                    addedDivs++;
                }
                // Add Bunk
                if (bunkName) {
                    if (!bunks.includes(bunkName)) {
                        bunks.push(bunkName);
                        addedBunks++;
                    }
                    const div = divisions[divName];
                    if (!div.bunks.includes(bunkName)) {
                        div.bunks.push(bunkName);
                        sortBunksInPlace(div.bunks);
                    }
                    // Handle Size or Roster
                    if (thirdCol) {
                        const asNum = parseInt(thirdCol);
                        const isNumeric = !isNaN(asNum) && String(asNum).length === String(thirdCol).trim().length;
                        
                        if (isNumeric) {
                            if (!bunkMetaData[bunkName]) bunkMetaData[bunkName] = {};
                            bunkMetaData[bunkName].size = asNum;
                            updatedSizes++;
                        } else if (thirdCol.length > 1) {
                            // Treat as camper name
                            camperRoster[thirdCol] = {
                                division: divName,
                                bunk: bunkName,
                                team: "" // Empty initially
                            };
                            addedCampers++;
                            
                            if (!bunkCounts[bunkName]) bunkCounts[bunkName] = 0;
                            bunkCounts[bunkName]++;
                        }
                    }
                }
            }
        }
        
        // Update sizes from counts if names were found
        Object.keys(bunkCounts).forEach(b => {
            if (!bunkMetaData[b]) bunkMetaData[b] = {};
            bunkMetaData[b].size = bunkCounts[b];
            updatedSizes++;
        });
        
        // Save Roster to global storage
        const currentGlobal = window.loadGlobalSettings?.() || {};
        if (!currentGlobal.app1) currentGlobal.app1 = {};
        currentGlobal.app1.camperRoster = camperRoster;
        window.saveGlobalSettings?.("app1", currentGlobal.app1);
        
        syncSpine();
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        
        alert(
            `Import Complete!\nAdded Divisions: ${addedDivs}\nAdded Bunks: ${addedBunks}\nUpdated Metadata: ${updatedSizes}\nCampers Imported: ${addedCampers}`
        );
    };
    reader.readAsText(file);
}



function renderBulkImportUI() {
    if (document.getElementById("bulk-data-card")) return;
    const grid = document.querySelector(".setup-grid");
    const target = grid || document.getElementById("division-detail-pane")?.parentNode;
    if (!target) return;
    
    const card = document.createElement("section");
    card.className = "setup-card setup-card-wide bulk-card";
    card.id = "bulk-data-card";
    
            <button id="btn-trigger-upload" style="background:#0094FF; color:white; border:none; padding:8px 18px; border-radius:999px; font-size:0.85rem; cursor:pointer; font-weight:600;">Upload CSV</button>
            <input type="file" id="bulk-upload-input" accept=".csv" style="display:none;">
        </div>
      </div>
    `;
    target.prepend(card);
    
    card.querySelector("#btn-manage-sports").onclick = showSportsRulesModal;
    card.querySelector("#btn-download-template").onclick = downloadTemplate;
    const uploadBtn = card.querySelector("#btn-trigger-upload");
    const uploadInput = card.querySelector("#bulk-upload-input");
    uploadBtn.onclick = () => uploadInput.click();
    uploadInput.onchange = e => {
        if (e.target.files.length > 0) {
            handleBulkImport(e.target.files[0]);
            uploadInput.value = "";
        }
    };
}

// -------------------- Core Logic --------------------
function addBunkToDivision(divName, bunkName) {
    if (!divName || !bunkName) return;
    const cleanDiv = String(divName).trim();
    const cleanBunk = String(bunkName).trim();
    if (!cleanDiv || !cleanBunk) return;
    if (!bunks.includes(cleanBunk)) bunks.push(cleanBunk);
    syncSpine();
    const div = divisions[cleanDiv];
    if (div && !div.bunks.includes(cleanBunk)) {
        div.bunks.push(cleanBunk);
        sortBunksInPlace(div.bunks);
    }
    if (!bunkMetaData[cleanBunk]) bunkMetaData[cleanBunk] = { size: 0 };
    saveData();
    renderDivisionDetailPane();
    window.updateTable?.();
}

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
    divisions[name] = {
        bunks: [],
        color,
        startTime: "",
        endTime: ""
    };
    syncSpine();
    selectedDivision = name;
    i.value = "";
    saveData();
    setupDivisionButtons();
    renderDivisionDetailPane();
    window.initLeaguesTab?.();
    window.updateTable?.();
}

// -------------------- UI Rendering --------------------
function setupDivisionButtons() {
    const cont = document.getElementById("divisionButtons");
    if (!cont) return;
    cont.innerHTML = "";
    if (!availableDivisions || availableDivisions.length === 0) {
        cont.innerHTML = `<p class="muted">No divisions created yet. Add one above or import via CSV.</p>`;
        renderDivisionDetailPane();
        return;
    }
    availableDivisions.forEach((name) => {
        const obj = divisions[name];
        if (!obj) return;
        let totalKids = 0;
        (obj.bunks || []).forEach(b => {
            const meta = bunkMetaData[b] || {};
            totalKids += meta.size || 0;
        });
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
        card.appendChild(topRow);
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
        const sub = document.createElement("div");
        sub.className = "division-card-subline";
        const bunkCount = (obj.bunks || []).length;
        sub.innerHTML = `${bunkCount} bunks • <strong>${totalKids}</strong> campers`;
        card.appendChild(sub);
        cont.appendChild(card);
    });
    renderDivisionDetailPane();
}

function renderDivisionDetailPane() {
    const pane = document.getElementById("division-detail-pane");
    if (!pane) return;
    pane.innerHTML = "";
    if (!selectedDivision || !divisions[selectedDivision]) {
        pane.innerHTML = `<p class="muted">Click a division on the left to set its <strong>times</strong>, color, and <strong>bunks</strong>.</p>`;
        return;
    }
    const divObj = divisions[selectedDivision];
    let totalKids = 0;
    divObj.bunks.forEach(b => {
        const meta = bunkMetaData[b] || {};
        totalKids += meta.size || 0;
    });
    
    // --- HEADER ---
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
    deleteBtn.style.cssText =
        "background:#FFFFFF; color:#DC2626; border:1px solid #FECACA; padding:6px 16px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.85rem; box-shadow:0 4px 10px rgba(220,38,38,0.12);";
    deleteBtn.onclick = () => {
        if (!confirm("Delete division \"" + selectedDivision + "\"?")) return;
        delete divisions[selectedDivision];
        syncSpine();
        const idx = availableDivisions.indexOf(selectedDivision);
        if (idx !== -1) availableDivisions.splice(idx, 1);
        selectedDivision = availableDivisions[0] || null;
        window.setGlobalDivisions?.(divisions);
        window.setGlobalBunks?.(bunks);
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.initLeaguesTab?.();
        window.updateTable?.();
    };
    header.appendChild(deleteBtn);
    pane.appendChild(header);
    
    // --- COLOR ROW ---
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
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.updateTable?.();
    };
    colorRow.appendChild(colorLabel);
    colorRow.appendChild(colorInput);
    pane.appendChild(colorRow);
    
    // --- INNER SHELL ---
    const shell = document.createElement("div");
    shell.className = "division-edit-shell";
    pane.appendChild(shell);
    
    // --- INNER HEADER ---
    const innerHeader = document.createElement("div");
    innerHeader.className = "division-edit-header";
    const leftSide = document.createElement("div");
    leftSide.className = "division-header-left";
    const dot = document.createElement("span");
    dot.className = "division-status-dot";
    dot.style.backgroundColor = divObj.color || "#00C896";
    dot.style.boxShadow = "0 0 0 4px " + (divObj.color || "#00C896") + "33";
    const titleName = document.createElement("span");
    titleName.textContent = selectedDivision;
    titleName.className = "division-name";
    makeEditable(titleName, (newName) => {
        const trimmed = newName.trim();
        const old = selectedDivision;
        if (!trimmed || trimmed === old) return;
        if (divisions[trimmed]) {
            alert("Exists.");
            return;
        }
        divisions[trimmed] = divisions[old];
        delete divisions[old];
        const idx = availableDivisions.indexOf(old);
        if (idx !== -1) availableDivisions[idx] = trimmed;
        selectedDivision = trimmed;
        window.setGlobalDivisions?.(divisions);
        window.setGlobalBunks?.(bunks);
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
        window.updateTable?.();
    });
    leftSide.appendChild(dot);
    leftSide.appendChild(titleName);
    const rightSide = document.createElement("div");
    rightSide.className = "division-header-summary";
    const bunkCount = (divObj.bunks || []).length;
    const timesSummary =
        divObj.startTime && divObj.endTime
            ? divObj.startTime + " – " + divObj.endTime
            : "Times not set";
    rightSide.innerHTML =
        bunkCount + " bunks • <strong>" + totalKids + "</strong> campers • " + timesSummary;
    innerHeader.appendChild(leftSide);
    innerHeader.appendChild(rightSide);
    shell.appendChild(innerHeader);
    
    // --- GRID ---
    const grid = document.createElement("div");
    grid.className = "division-edit-grid";
    shell.appendChild(grid);
    
    // === TIME CARD ===
    const timeCard = document.createElement("div");
    timeCard.className = "division-mini-card";
    timeCard.innerHTML = `
        <div class="division-mini-header"><span>Division Times</span></div>
        <p class="division-mini-help">Set the daily time window this division is in camp.</p>
    `;
    const timeForm = document.createElement("div");
    timeForm.style.cssText =
        "display:flex; align-items:center; gap:8px; margin-top:4px;";
    const startInput = document.createElement("input");
    startInput.value = divObj.startTime || "";
    startInput.placeholder = "9:00am";
    startInput.style.cssText =
        "width:80px; padding:4px 8px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.85rem;";
    const toLabel = document.createElement("span");
    toLabel.textContent = "to";
    toLabel.className = "muted";
    const endInput = document.createElement("input");
    endInput.value = divObj.endTime || "";
    endInput.placeholder = "4:00pm";
    endInput.style.cssText =
        "width:80px; padding:4px 8px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.85rem;";
    const updateBtn = document.createElement("button");
    updateBtn.textContent = "Save";
    updateBtn.style.cssText =
        "background:#00C896; color:white; border:none; padding:4px 12px; border-radius:999px; font-weight:600; cursor:pointer;";
    updateBtn.onclick = () => {
        divObj.startTime = startInput.value;
        divObj.endTime = endInput.value;
        saveData();
        setupDivisionButtons();
        renderDivisionDetailPane();
    };
    timeForm.append(startInput, toLabel, endInput, updateBtn);
    timeCard.appendChild(timeForm);
    grid.appendChild(timeCard);
    
    // === BUNKS CARD ===
    const bunksCard = document.createElement("div");
    bunksCard.className = "division-mini-card";
    bunksCard.innerHTML = `
        <div class="division-mini-header"><span>Bunks in this Division</span></div>
        <p class="division-mini-help">
            Click to edit name/size.<br>
            <strong>Double-click to delete.</strong>
        </p>
    `;
    const bunkList = document.createElement("div");
    bunkList.style.cssText =
        "margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;";
    if (!divObj.bunks || divObj.bunks.length === 0) {
        bunkList.innerHTML = `<p class="muted">No bunks assigned yet.</p>`;
    } else {
        const sorted = divObj.bunks.slice().sort(compareBunks);
        sorted.forEach(bName => {
            const meta = bunkMetaData[bName] || { size: 0 };
            const pill = document.createElement("span");
            pill.className = "division-bunk-pill";
            pill.innerHTML = bName + ' <span class="bunk-size-badge">' + (meta.size || 0) + '</span>';
            let clickTimer = null;
            const clickDelay = 260;
            function startInlineEdit() {
                const form = document.createElement("span");
                form.className = "bunk-edit-form";
                const nameIn = document.createElement("input");
                nameIn.value = bName;
                nameIn.className = "bunk-edit-input";
                const sizeIn = document.createElement("input");
                sizeIn.type = "number";
                sizeIn.value = meta.size || "";
                sizeIn.placeholder = "#";
                sizeIn.className = "bunk-edit-size";
                const saveBtn = document.createElement("button");
                saveBtn.className = "bunk-edit-save";
                saveBtn.innerHTML = "✓";
                const cancel = () => renderDivisionDetailPane();
                const save = () =>
                    renameBunkEverywhere(bName, nameIn.value, sizeIn.value);
                saveBtn.onclick = ev => {
                    ev.stopPropagation();
                    save();
                };
                nameIn.onkeyup = ev => {
                    if (ev.key === "Enter") save();
                    if (ev.key === "Escape") cancel();
                };
                sizeIn.onkeyup = ev => {
                    if (ev.key === "Enter") save();
                    if (ev.key === "Escape") cancel();
                };
                form.append(nameIn, sizeIn, saveBtn);
                pill.replaceWith(form);
                nameIn.focus();
            }
            pill.onclick = e => {
                e.stopPropagation();
                if (clickTimer) {
                    clearTimeout(clickTimer);
                    clickTimer = null;
                    const idx = divObj.bunks.indexOf(bName);
                    if (idx !== -1) {
                        divObj.bunks.splice(idx, 1);
                        syncSpine();
                        saveData();
                        renderDivisionDetailPane();
                        window.updateTable?.();
                    }
                } else {
                    clickTimer = setTimeout(() => {
                        clickTimer = null;
                        startInlineEdit();
                    }, clickDelay);
                }
            };
            bunkList.appendChild(pill);
        });
    }
    bunksCard.appendChild(bunkList);
    
    // Add Bunk Row
    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex; gap:6px; margin-top:10px;";
    const addInput = document.createElement("input");
    addInput.placeholder = "New Bunk Name";
    addInput.style.cssText =
        "flex:1; padding:5px 10px; border-radius:999px; border:1px solid #D1D5DB; font-size:0.86rem;";
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.style.cssText =
        "padding:5px 14px; border-radius:999px; border:none; background:#00C896; color:white; font-size:0.85rem; font-weight:600; cursor:pointer;";
    const doAdd = () => {
        if (!addInput.value.trim()) return;
        addBunkToDivision(selectedDivision, addInput.value.trim());
        addInput.value = "";
    };
    addBtn.onclick = doAdd;
    addInput.onkeyup = e => {
        if (e.key === "Enter") doAdd();
    };
    addRow.append(addInput, addBtn);
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
        bunkMetaData,
        sportMetaData
    };
    window.setGlobalDivisions?.(divisions);
    window.setGlobalBunks?.(bunks);
    window.saveGlobalSettings?.("app1", data);
}

function loadData() {
    const data = window.loadGlobalSettings?.().app1 || {};
    try {
        divisions = window.getGlobalDivisions ? window.getGlobalDivisions() : (data.divisions || {});
        bunks = window.getGlobalBunks ? window.getGlobalBunks() : (data.bunks || []);
        availableDivisions = Object.keys(divisions);
        specialActivities = data.specialActivities || [];
        bunkMetaData = data.bunkMetaData || {};
        sportMetaData = data.sportMetaData || {};
        Object.keys(divisions).forEach(divName => {
            divisions[divName].startTime = divisions[divName].startTime || "";
            divisions[divName].endTime = divisions[divName].endTime || "";
            divisions[divName].bunks = divisions[divName].bunks || [];
            sortBunksInPlace(divisions[divName].bunks);
            divisions[divName].color = divisions[divName].color || defaultColors[0];
        });
        window.divisions = divisions;
        window.availableDivisions = availableDivisions;
        selectedDivision = data.selectedDivision || availableDivisions[0] || null;
        allSports =
            data.allSports && Array.isArray(data.allSports)
                ? data.allSports
                : [...defaultSports];
        savedSkeletons = data.savedSkeletons || {};
        skeletonAssignments = data.skeletonAssignments || {};
    } catch (e) {
        console.error("Error loading app1 data:", e);
    }
}

// -------------------- Init --------------------
function initApp1() {
    console.log("📋 app1.js: initApp1() called");
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
    renderBulkImportUI();
    console.log("📋 app1.js: initApp1() complete");
}

window.initApp1 = initApp1;

// Global Exports
window.getDivisions = () => divisions;
window.getAllGlobalSports = () => (allSports || []).slice().sort();
window.addGlobalSport = (sportName) => {
    if (!sportName) return;
    const s = sportName.trim();
    if (s && !allSports.find(sp => sp.toLowerCase() === s.toLowerCase())) {
        allSports.push(s);
        saveData();
    }
};
window.getSavedSkeletons = () => savedSkeletons || {};
window.saveSkeleton = (name, skeletonData) => {
    if (!name || !skeletonData) return;
    savedSkeletons[name] = skeletonData;
    saveData();
};
window.deleteSkeleton = (name) => {
    if (!name) return;
    delete savedSkeletons[name];
    Object.keys(skeletonAssignments).forEach(day => {
        if (skeletonAssignments[day] === name)
            delete skeletonAssignments[day];
    });
    saveData();
};
window.getSkeletonAssignments = () => skeletonAssignments || {};
window.saveSkeletonAssignments = (assignments) => {
    if (!assignments) return;
    skeletonAssignments = assignments;
    saveData();
};
window.getGlobalSpecialActivities = () => specialActivities;
window.saveGlobalSpecialActivities = (updatedActivities) => {
    specialActivities = updatedActivities;
    saveData();
};
window.addDivisionBunk = addBunkToDivision;

// ---------------------------------------------
// EXPOSE MASTER APP1 OBJECT FOR THE SCHEDULER
// ---------------------------------------------
window.app1 = {
    // core camp structural data
    divisions,
    bunks,
    availableDivisions,
    // schedule window (if global)
    startTime: "9:00am",
    endTime: "4:00pm",
    // duration defaults
    defaultDurations: {
        "General Activity": 60,
        "Sports Slot": 60,
        "Special Activity": 60,
        "Swim": 60,
        "League Game": 60,
        "Specialty League": 60
    },
    // this is required for timeline building
    increments: 30,
    // if you store global activities (optional)
    activities: window.getGlobalSpecialActivities?.() || [],
    // metadata
    bunkMetaData,
    sportMetaData
};

console.log("📋 app1.js: window.initApp1 ready");
})();
