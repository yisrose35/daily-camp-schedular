// -------------------- Auto Save / Load / Erase --------------------

// Save the current state into localStorage
function saveData() {
  const state = {
    bunks,
    divisions,
    availableDivisions,
    selectedDivision,
    fields,
    specialActivities,
    leagues,
    timeTemplates,
    activityDuration,
    unifiedTimes,
    scheduleAssignments
  };
  localStorage.setItem("campSchedulerData", JSON.stringify(state));
}

// Load state from localStorage
function loadData() {
  const raw = localStorage.getItem("campSchedulerData");
  if (!raw) return;

  try {
    const state = JSON.parse(raw);

    bunks = state.bunks || [];
    divisions = state.divisions || {};
    availableDivisions = state.availableDivisions || [];
    selectedDivision = state.selectedDivision || null;
    fields = state.fields || [];
    specialActivities = state.specialActivities || [];
    leagues = state.leagues || {};
    timeTemplates = state.timeTemplates || [];
    activityDuration = state.activityDuration || 30;
    unifiedTimes = state.unifiedTimes || [];
    scheduleAssignments = state.scheduleAssignments || {};

    // After loading, re-render everything
    renderBunks();
    renderDivisions();
    renderFields();
    renderSpecialActivities();
    renderTimeTemplates();
    renderLeagues();
    renderScheduleTable();
  } catch (e) {
    console.error("Error loading saved data:", e);
  }
}

// Erase all saved data from localStorage
function eraseData() {
  if (confirm("Are you sure you want to erase all saved data? This cannot be undone.")) {
    localStorage.removeItem("campSchedulerData");

    // Reset state variables
    bunks = [];
    divisions = {};
    availableDivisions = [];
    selectedDivision = null;
    fields = [];
    specialActivities = [];
    leagues = {};
    timeTemplates = [];
    activityDuration = 30;
    unifiedTimes = [];
    scheduleAssignments = {};

    // Clear UI
    renderBunks();
    renderDivisions();
    renderFields();
    renderSpecialActivities();
    renderTimeTemplates();
    renderLeagues();
    renderScheduleTable();

    alert("🗑️ All data erased.");
  }
}

// -------------------- Auto Save on Changes --------------------
// Wrap key render/input functions so every change gets saved

function autoSaveWrapper(originalFn) {
  return function (...args) {
    const result = originalFn.apply(this, args);
    saveData();
    return result;
  };
}

// Wrap your render and mutating functions so any update triggers save
window.addEventListener("DOMContentLoaded", () => {
  loadData();

  // Wrap functions that change state
  if (typeof renderBunks === "function") renderBunks = autoSaveWrapper(renderBunks);
  if (typeof renderDivisions === "function") renderDivisions = autoSaveWrapper(renderDivisions);
  if (typeof renderFields === "function") renderFields = autoSaveWrapper(renderFields);
  if (typeof renderSpecialActivities === "function") renderSpecialActivities = autoSaveWrapper(renderSpecialActivities);
  if (typeof renderTimeTemplates === "function") renderTimeTemplates = autoSaveWrapper(renderTimeTemplates);
  if (typeof renderLeagues === "function") renderLeagues = autoSaveWrapper(renderLeagues);
  if (typeof renderScheduleTable === "function") renderScheduleTable = autoSaveWrapper(renderScheduleTable);
});
