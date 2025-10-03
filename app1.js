// -------------------- State --------------------
let bunks = [];
let divisions = [];
let fields = [];
let times = [];

// -------------------- Helpers --------------------
function createButton(text, color, onClick) {
  const btn = document.createElement("button");
  btn.textContent = text;
  btn.style.backgroundColor = color || "#f0f0f0";
  btn.className = "item-button";
  btn.onclick = onClick;
  return btn;
}

function createEditableButton(item, index, list, renderFn) {
  const btn = document.createElement("button");
  btn.textContent = item.name;
  btn.className = "item-button";
  btn.style.backgroundColor = item.color || "#f0f0f0";

  btn.onclick = () => {
    const newName = prompt("Edit name:", item.name);
    if (newName !== null && newName.trim() !== "") {
      list[index].name = newName.trim();
      renderFn();
    }
  };

  return btn;
}

// -------------------- Render Functions --------------------
function renderBunks() {
  const container = document.getElementById("bunk-list");
  container.innerHTML = "";
  bunks.forEach((bunk, i) => {
    container.appendChild(
      createEditableButton(bunk, i, bunks, renderBunks)
    );
  });
}

function renderDivisions() {
  const container = document.getElementById("division-list");
  container.innerHTML = "";
  divisions.forEach((division, i) => {
    container.appendChild(
      createEditableButton(division, i, divisions, renderDivisions)
    );
  });
}

function renderFields() {
  const container = document.getElementById("field-list");
  container.innerHTML = "";
  fields.forEach((field, i) => {
    container.appendChild(
      createEditableButton(field, i, fields, renderFields)
    );
  });
}

function renderTimes() {
  const container = document.getElementById("time-list");
  container.innerHTML = "";
  times.forEach((time, i) => {
    container.appendChild(
      createEditableButton(time, i, times, renderTimes)
    );
  });
}

// -------------------- Add Functions --------------------
function addBunk() {
  const input = document.getElementById("bunk-input");
  if (input.value.trim() !== "") {
    bunks.push({ name: input.value.trim(), color: "" });
    input.value = "";
    renderBunks();
  }
}

function addDivision() {
  const input = document.getElementById("division-input");
  if (input.value.trim() !== "") {
    divisions.push({ name: input.value.trim(), color: getRandomColor() });
    input.value = "";
    renderDivisions();
  }
}

function addField() {
  const input = document.getElementById("field-input");
  if (input.value.trim() !== "") {
    fields.push({ name: input.value.trim(), color: "" });
    input.value = "";
    renderFields();
  }
}

function addTime() {
  const input = document.getElementById("time-input");
  if (input.value.trim() !== "") {
    times.push({ name: input.value.trim(), color: "" });
    input.value = "";
    renderTimes();
  }
}

// -------------------- Utilities --------------------
function getRandomColor() {
  const colors = ["#FF7F7F", "#7FBFFF", "#7FFF7F", "#FFBF7F", "#BF7FFF"];
  return colors[Math.floor(Math.random() * colors.length)];
}

function enableEnterKey(inputId, addFn) {
  const input = document.getElementById(inputId);
  input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      addFn();
    }
  });
}

// -------------------- Init --------------------
window.onload = () => {
  enableEnterKey("bunk-input", addBunk);
  enableEnterKey("division-input", addDivision);
  enableEnterKey("field-input", addField);
  enableEnterKey("time-input", addTime);
};
