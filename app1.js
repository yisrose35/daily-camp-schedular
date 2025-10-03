// -------------------- State --------------------
let bunks = [];
let divisions = [];

// -------------------- Helpers --------------------
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
    container.appendChild(createEditableButton(bunk, i, bunks, renderBunks));
  });
}

function renderDivisions() {
  const container = document.getElementById("division-list");
  container.innerHTML = "";
  divisions.forEach((division, i) => {
    container.appendChild(createEditableButton(division, i, divisions, renderDivisions));
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
    divisions.push({ name: input.value.trim(), color: getRandomColor(), bunks: [] });
    input.value = "";
    renderDivisions();
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
window.addEventListener("DOMContentLoaded", () => {
  enableEnterKey("bunk-input", addBunk);
  enableEnterKey("division-input", addDivision);

  document.getElementById("addBunkBtn").onclick = addBunk;
  document.getElementById("addDivisionBtn").onclick = addDivision;
});
