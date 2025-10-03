// -------------------- Save / Load / Erase --------------------

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

    // Re-render everything after loading
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

// Utility to wrap a function so it always triggers save after execution
function autoSaveWrapper(originalFn) {
  return function (...args) {
    const result = originalFn.apply(this, args);
    saveData();
    return result;
  };
}

// Hook auto-save into key actions
window.addEventListener("DOMContentLoaded", () => {
  loadData();

  // Wrap add/remove functions
  if (typeof addBunk === "function") addBunk = autoSaveWrapper(addBunk);
  if (typeof addDivision === "function") addDivision = autoSaveWrapper(addDivision);
  if (typeof addField === "function") addField = autoSaveWrapper(addField);
  if (typeof addSpecialActivity === "function") addSpecialActivity = autoSaveWrapper(addSpecialActivity);
  if (typeof addTimeTemplate === "function") addTimeTemplate = autoSaveWrapper(addTimeTemplate);
  if (typeof generateTimes === "function") generateTimes = autoSaveWrapper(generateTimes);

  // Save whenever schedule is regenerated
  if (typeof assignFieldsToBunks === "function") {
    assignFieldsToBunks = autoSaveWrapper(assignFieldsToBunks);
  }

  // Mutation observer for name editing (inline edits on bunk/division/etc.)
  document.body.addEventListener("blur", (e) => {
    if (e.target && e.target.tagName === "INPUT" && e.target.dataset.editing === "true") {
      saveData();
    }
  }, true);
});
