// -------------------- State --------------------
let bunks = [];
let divisions = {};  // { divName:{ bunks:[], color, start, end } }
let availableDivisions = [];
let selectedDivision = null;

let fields = [], specialActivities = [];
let leagues = {};    // { divName:{enabled:boolean, sports:string[]} }

let timeTemplates = []; // [{start,end,divisions:[]}]
let activityDuration = 30;
let scheduleAssignments = {}; // { bunkName: [ per unified row index: {field,sport,continuation,isLeague,_skip} ] }
let unifiedTimes = []; // [{start:Date,end:Date,label:string}]
let divisionActiveRows = {}; // { divName: Set(rowIndices) }

const defaultColors = ['#4CAF50','#2196F3','#E91E63','#FF9800','#9C27B0','#00BCD4','#FFC107','#F44336','#8BC34A','#3F51B5'];

// -------------------- INIT --------------------
window.addEventListener("DOMContentLoaded", () => {
  loadData();
  renderBunks();
});

// -------------------- Add Bunk --------------------
document.getElementById("addBunkBtn").addEventListener("click", addBunk);
document.getElementById("bunkInput").addEventListener("keypress", e => {
  if (e.key === "Enter") addBunk();
});

function addBunk() {
  const input = document.getElementById("bunkInput");
  const bunkName = input.value.trim();
  if (!bunkName) return;

  // prevent duplicates
  if (bunks.includes(bunkName)) {
    alert("This bunk already exists!");
    input.value = "";
    return;
  }

  // add to list and save
  bunks.push(bunkName);
  saveData();

  // update display
  renderBunks();
  input.value = "";
}

function renderBunks() {
  const container = document.getElementById("unassignedBunks");
  container.innerHTML = ""; // clear old display

  bunks.forEach(b => {
    const btn = document.createElement("button");
    btn.textContent = b;
    btn.classList.add("bunk-btn");
    btn.addEventListener("click", () => toggleBunkDivision(b));
    container.appendChild(btn);
  });
}

// -------------------- Division Assignment --------------------
function toggleBunkDivision(bunk) {
  if (!selectedDivision) {
    alert("Select a division first before assigning bunks.");
    return;
  }

  const div = divisions[selectedDivision];
  if (!div.bunks.includes(bunk)) {
    div.bunks.push(bunk);
  } else {
    div.bunks = div.bunks.filter(x => x !== bunk);
  }

  saveData();
  renderBunks();
  renderDivisions();
}

// -------------------- Add Division --------------------
function addDivision() {
  const nameInput = document.getElementById("divisionName");
  const divName = nameInput.value.trim();
  if (!divName) return;
  if (divisions[divName]) {
    alert("Division already exists!");
    nameInput.value = "";
    return;
  }

  const color = defaultColors[Object.keys(divisions).length % defaultColors.length];
  divisions[divName] = { bunks: [], color, start: "", end: "" };
  availableDivisions.push(divName);
  saveData();
  renderDivisions();
  nameInput.value = "";
}

document.getElementById("addDivisionBtn")?.addEventListener("click", addDivision);
document.getElementById("divisionName")?.addEventListener("keypress", e => {
  if (e.key === "Enter") addDivision();
});

function renderDivisions() {
  const divContainer = document.getElementById("divisionsList");
  if (!divContainer) return;

  divContainer.innerHTML = "";
  for (const [name, div] of Object.entries(divisions)) {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.style.backgroundColor = div.color;
    btn.classList.add("division-btn");
    btn.addEventListener("click", () => selectDivision(name));
    divContainer.appendChild(btn);
  }
}

function selectDivision(name) {
  selectedDivision = name;
  document.querySelectorAll(".division-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".division-btn").forEach(b => {
    if (b.textContent === name) b.classList.add("active");
  });
  renderBunks();
}

// -------------------- Local Storage --------------------
function saveData() {
  const data = {
    bunks,
    divisions,
    availableDivisions,
    selectedDivision
  };
  localStorage.setItem("campSchedulerData", JSON.stringify(data));
}

function loadData() {
  const stored = localStorage.getItem("campSchedulerData");
  if (!stored) return;
  try {
    const data = JSON.parse(stored);
    bunks = data.bunks || [];
    divisions = data.divisions || {};
    availableDivisions = data.availableDivisions || [];
    selectedDivision = data.selectedDivision || null;
  } catch (e) {
    console.error("Error loading data:", e);
  }
}

// -------------------- Erase All Data --------------------
document.getElementById("eraseAllBtn")?.addEventListener("click", () => {
  if (confirm("Are you sure you want to erase all camp data?")) {
    localStorage.removeItem("campSchedulerData");
    bunks = [];
    divisions = {};
    availableDivisions = [];
    selectedDivision = null;
    renderBunks();
    renderDivisions();
  }
});
