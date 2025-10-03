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
    unifiedTimes
  };
  localStorage.setItem("campSchedulerData", JSON.stringify(state));
  alert("✅ Data saved successfully!");
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

    // After loading, re-render everything
    renderBunks();
    renderDivisions();
    renderFields();
    renderSpecialActivities();
    renderTimeTemplates();
    renderLeagues();

    alert("📂 Data loaded successfully!");
  } catch (e) {
    console.error("Error loading saved data:", e);
    alert("⚠️ Failed to load saved data.");
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

// -------------------- Auto Load on Page Start --------------------
window.addEventListener("DOMContentLoaded", () => {
  loadData();
});
