// -------------------- State --------------------
let bunks = [];
let divisions = [];
let fields = [];
let specialActivities = [];
let times = [];

// -------------------- Persistence --------------------
function saveData() {
  const data = { bunks, divisions, fields, specialActivities, times };
  localStorage.setItem("campSchedulerData", JSON.stringify(data));
}

function loadData() {
  const saved = localStorage.getItem("campSchedulerData");
  if (saved) {
    const data = JSON.parse(saved);
    bunks = data.bunks || [];
    divisions = data.divisions || [];
    fields = data.fields || [];
    specialActivities = data.specialActivities || [];
    times = data.times || [];
    renderAll();
  }
}

function resetData() {
  if (confirm("Are you sure you want to erase all saved data?")) {
    localStorage.removeItem("campSchedulerData");
    bunks = [];
    divisions = [];
    fields = [];
    specialActivities = [];
    times = [];
    renderAll();
  }
}

// Auto-save after every action
function autoSave() {
  saveData();
}

// -------------------- UI Tabs --------------------
function showTab(tabId) {
  document.querySelectorAll(".tab-content").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  event.target.classList.add("active");
}

// -------------------- Setup Actions --------------------
function addBunk() {
  const val = document.getElementById("bunkInput").value.trim();
  if (val) {
    bunks.push(val);
    document.getElementById("bunkInput").value = "";
    renderBunks();
    autoSave();
  }
}

function addDivision() {
  const val = document.getElementById("divisionInput").value.trim();
  if (val) {
    divisions.push(val);
    document.getElementById("divisionInput").value = "";
    renderDivisions();
    autoSave();
  }
}

function addField() {
  const val = document.getElementById("fieldInput").value.trim();
  if (val) {
    fields.push({ name: val, activities: [], available: true });
    document.getElementById("fieldInput").value = "";
    renderFields();
    autoSave();
  }
}

function addSpecial() {
  const val = document.getElementById("specialInput").value.trim();
  if (val) {
    specialActivities.push({ name: val, available: true });
    document.getElementById("specialInput").value = "";
    renderSpecials();
    autoSave();
  }
}

function setTimes() {
  const start = document.getElementById("startTimeInput").value.trim();
  const end = document.getElementById("endTimeInput").value.trim();
  const interval = parseInt(document.getElementById("intervalSelect").value);

  if (start && end && interval) {
    times = [{ start, end, interval }];
    renderTimes();
    autoSave();
  }
}

// -------------------- Render --------------------
function renderBunks() {
  const list = document.getElementById("bunkList");
  list.innerHTML = bunks.map(b => `<button class="bunk-button">${b}</button>`).join("");
}

function renderDivisions() {
  const list = document.getElementById("divisionList");
  list.innerHTML = divisions.map(d => `<button class="division-button">${d}</button>`).join("");
}

function renderFields() {
  const list = document.getElementById("fieldList");
  list.innerHTML = fields.map(f => `<button class="field-button">${f.name}</button>`).join("");
}

function renderSpecials() {
  const list = document.getElementById("specialList");
  list.innerHTML = specialActivities.map(s => `<button class="special-button">${s.name}</button>`).join("");
}

function renderTimes() {
  const list = document.getElementById("timeList");
  list.innerHTML = times.map(t => `<div>${t.start} - ${t.end} (${t.interval} min)</div>`).join("");
}

function renderAll() {
  renderBunks();
  renderDivisions();
  renderFields();
  renderSpecials();
  renderTimes();
}

// -------------------- On Page Load --------------------
window.onload = () => {
  loadData();
};
