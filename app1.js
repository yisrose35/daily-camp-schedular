// -------------------- State --------------------
let bunks = [];       // { name, color, division: null|string }
let divisions = [];   // { name, color, bunks: [], start, end }

// -------------------- Helpers --------------------
function makeEditable(element, saveFn) {
  element.ondblclick = () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = element.textContent;
    element.replaceWith(input);
    input.focus();

    const save = () => {
      const newName = input.value.trim();
      if (newName) saveFn(newName);
      renderBunks();
      renderDivisions();
      if (typeof onDivisionsChanged === "function") onDivisionsChanged();
    };
    input.addEventListener("blur", save);
    input.addEventListener("keypress", e => { if (e.key === "Enter") save(); });
  };
}

// -------------------- Render Functions --------------------
function renderBunks() {
  const container = document.getElementById("bunk-list");
  container.innerHTML = "";
  bunks.filter(b => !b.division).forEach((bunk, i) => {
    const wrap = document.createElement("div");
    wrap.className = "fieldWrapper";

    const label = document.createElement("span");
    label.textContent = bunk.name;
    makeEditable(label, newName => { bunks[i].name = newName; });
    wrap.appendChild(label);

    const select = document.createElement("select");
    const optDefault = document.createElement("option");
    optDefault.textContent = "Assign to division";
    optDefault.disabled = true; optDefault.selected = true;
    select.appendChild(optDefault);

    divisions.forEach(div => {
      const opt = document.createElement("option");
      opt.value = div.name; opt.textContent = div.name;
      select.appendChild(opt);
    });

    select.onchange = () => {
      const divisionName = select.value;
      bunks[i].division = divisionName;
      const divObj = divisions.find(d => d.name === divisionName);
      if (divObj && !divObj.bunks.includes(bunks[i].name)) divObj.bunks.push(bunks[i].name);
      renderBunks(); renderDivisions();
      if (typeof onDivisionsChanged === "function") onDivisionsChanged();
    };

    wrap.appendChild(select);
    container.appendChild(wrap);
  });
}

function renderDivisions() {
  const container = document.getElementById("division-list");
  container.innerHTML = "";
  divisions.forEach((division, i) => {
    const wrap = document.createElement("div");
    wrap.className = "fieldWrapper";

    const label = document.createElement("span");
    label.textContent = division.name;
    label.style.backgroundColor = division.color; label.style.color = "#fff";
    makeEditable(label, newName => { divisions[i].name = newName; });
    wrap.appendChild(label);

    if (division.bunks.length > 0) {
      const bunkList = document.createElement("ul");
      division.bunks.forEach(bName => {
        const li = document.createElement("li");
        li.textContent = bName;
        bunkList.appendChild(li);
      });
      wrap.appendChild(bunkList);
    }
    container.appendChild(wrap);
  });
}

// -------------------- Add Functions --------------------
function addBunk() {
  const input = document.getElementById("bunk-input");
  if (!input.value.trim()) return;
  bunks.push({ name: input.value.trim(), color: "", division: null });
  input.value = "";
  renderBunks();
}

function addDivision() {
  const input = document.getElementById("division-input");
  if (!input.value.trim()) return;
  divisions.push({ name: input.value.trim(), color: getRandomColor(), bunks: [] });
  input.value = "";
  renderDivisions();
  renderBunks();
  if (typeof onDivisionsChanged === "function") onDivisionsChanged();
}

// -------------------- Utilities --------------------
function getRandomColor() {
  const colors = ["#FF7F7F", "#7FBFFF", "#7FFF7F", "#FFBF7F", "#BF7FFF"];
  return colors[Math.floor(Math.random() * colors.length)];
}
function enableEnterKey(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("keypress", e => { if (e.key === "Enter") fn(); });
}

// -------------------- Init --------------------
window.addEventListener("DOMContentLoaded", () => {
  enableEnterKey("bunk-input", addBunk);
  enableEnterKey("division-input", addDivision);
  document.getElementById("addBunkBtn").onclick = addBunk;
  document.getElementById("addDivisionBtn").onclick = addDivision;
  // First render
  renderBunks(); renderDivisions();
  if (typeof onDivisionsChanged === "function") onDivisionsChanged();
});

