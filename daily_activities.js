// dailyActivities.js — Fixed Daily Activities (Lunch/Mincha/Swim/etc.)
(function(){
  const STORAGE_KEY = "fixedActivities_v2";
  let fixedActivities = []; // { id, name, start:"HH:MM", end:"HH:MM", divisions:[string], enabled:boolean }

  // -------------------- Helpers --------------------
  function uid() { return Math.random().toString(36).slice(2,9); }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(raw);
      fixedActivities = Array.isArray(parsed) ? parsed : [];
    } catch { fixedActivities = []; }
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(fixedActivities)); }

  function pad(n){ return (n<10?'0':'') + n; }

  // Accept 12h/24h → return "HH:MM" (24h)
  function normalizeTime(str){
    if(!str) return null;
    str = String(str).trim().toLowerCase();
    const tmp = str.replace(/[^0-9apm:]/g, "");
    if(!tmp) return null;
    const ampmMatch = tmp.match(/(am|pm)$/);
    const hasAmPm = !!ampmMatch;
    const ampm = hasAmPm ? ampmMatch[1] : null;
    const timePart = tmp.replace(/(am|pm)$/,'');
    const m = timePart.match(/^(\d{1,2}):(\d{2})$/);
    if(!m) return null;
    let hh = parseInt(m[1],10);
    const mm = parseInt(m[2],10);
    if(mm<0||mm>59) return null;
    if(hasAmPm){
      if(hh===12) hh = (ampm==='am') ? 0 : 12;
      else hh = (ampm==='pm') ? hh+12 : hh;
    }
    if(hh<0||hh>23) return null;
    return `${pad(hh)}:${pad(mm)}`;
  }

  function toMinutes(hhmm){
    if(!hhmm) return null;
    const [h,m] = hhmm.split(":").map(Number);
    return h*60+m;
  }

  function to12hLabel(hhmm){
    const mins = toMinutes(hhmm);
    if(mins==null) return "--:--";
    let h = Math.floor(mins/60), m = mins%60;
    const am = h<12; let labelH = h%12; if(labelH===0) labelH=12;
    return `${labelH}:${pad(m)} ${am? 'AM':'PM'}`;
  }

  function minutesOf(d){ return d.getHours()*60 + d.getMinutes(); }

  function rowsForBlock(startMin, endMin){
    if(!Array.isArray(window.unifiedTimes)) return [];
    const rows = [];
    for(let i=0;i<unifiedTimes.length;i++){
      const row = unifiedTimes[i];
      if(!(row && row.start && row.end)) continue;
      const rs = minutesOf(new Date(row.start));
      const re = minutesOf(new Date(row.end));
      if(rs>=startMin && re<=endMin){ rows.push(i); }
    }
    return rows;
  }

  function resolveTargetDivisions(divs){
    const avail = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    if(!divs || !divs.length) return avail.slice();
    return divs.filter(d => avail.includes(d));
  }

  // -------------------- UI --------------------
  let rootEl, chipsWrap, listEl, nameInput, startInput, endInput, addBtn, infoEl;

  function ensureMount(){
    nameInput = document.getElementById('fixedName');
    startInput = document.getElementById('fixedStart');
    endInput = document.getElementById('fixedEnd');
    addBtn = document.getElementById('addFixedBtn');
    chipsWrap = document.getElementById('fixedDivisionsBox');
    listEl = document.getElementById('fixedList');
    rootEl = document.getElementById('fixed-activities');

    if (!document.getElementById('da_info')) {
      infoEl = document.createElement('div');
      infoEl.id = 'da_info';
      infoEl.className = 'muted';
      (addBtn?.parentElement || rootEl)?.appendChild(infoEl);
    } else {
      infoEl = document.getElementById('da_info');
    }
  }

  function renderChips(){
    if (!chipsWrap) return;
    chipsWrap.className = 'chips';
    chipsWrap.innerHTML = '';

    const divs = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    divs.forEach(d => {
      const el = document.createElement('span');
      el.className = 'bunk-button'; // your push button style
      el.textContent = d;
      el.dataset.value = d;
      el.addEventListener('click', ()=> el.classList.toggle('selected'));
      chipsWrap.appendChild(el);
    });
  }

  function getSelectedDivisions(){
    if (!chipsWrap) return [];
    return Array.from(chipsWrap.querySelectorAll('.bunk-button.selected')).map(x=>x.dataset.value);
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function renderList(){
    if(!listEl) return;

    if(!fixedActivities.length){
      listEl.innerHTML = '<div class="muted">No fixed activities yet.</div>';
      return;
    }
    listEl.innerHTML = '';

    fixedActivities.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '15px';
      row.style.padding = '8px 0';
      row.style.borderBottom = '1px solid #eee';

      const targets = resolveTargetDivisions(item.divisions);
      const label = `${targets.join(', ') || 'All'}`;

      const info = document.createElement('div');
      info.style.flex = '1 1 auto';
      info.innerHTML = `
        <div><strong>${escapeHtml(item.name)}</strong></div>
        <div class="muted" style="font-size:0.9em;">${to12hLabel(item.start)} - ${to12hLabel(item.end)} &bull; Applies to: ${escapeHtml(label)}</div>
      `;

      // Slider toggle (ENABLED state)
      const toggleWrap = document.createElement('label');
      toggleWrap.className = 'switch';
      toggleWrap.title = item.enabled ? 'Enabled' : 'Disabled';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!item.enabled;

      const slider = document.createElement('span');
      slider.className = 'slider';

      toggle.addEventListener('change', () => {
        item.enabled = toggle.checked;
        save();
        toggleWrap.title = item.enabled ? 'Enabled' : 'Disabled';
        // If the schedule grid is visible, refresh it
        window.updateTable?.();
      });

      toggleWrap.appendChild(toggle);
      toggleWrap.appendChild(slider);

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.className = 'bunk-button';
      removeBtn.style.background = '#ef4444';
      removeBtn.style.color = '#fff';
      removeBtn.addEventListener('click', () => {
        fixedActivities = fixedActivities.filter(x=>x.id!==item.id);
        save();
        renderList();
        window.updateTable?.();
      });

      row.appendChild(info);
      row.appendChild(toggleWrap);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
  }

  function onAdd(){
    if(!nameInput || !startInput || !endInput) return tip('UI elements not found. Initialization failed.');

    const name = (nameInput.value||'').trim();
    const ns = normalizeTime(startInput.value);
    const ne = normalizeTime(endInput.value);
    if(!name){ return tip('Please enter a name.'); }
    if(!ns || !ne){ return tip('Please enter valid start and end times (e.g., 12:00pm).'); }
    const ms = toMinutes(ns), me = toMinutes(ne);
    if(me<=ms){ return tip('End must be after start.'); }

    const divisionsSel = getSelectedDivisions();
    fixedActivities.push({ id:uid(), name, start:ns, end:ne, divisions:divisionsSel, enabled:true });
    save();

    nameInput.value = ''; startInput.value = ''; endInput.value = '';
    chipsWrap?.querySelectorAll('.bunk-button.selected').forEach(c=>c.classList.remove('selected'));

    tip('Added.');
    renderList();
    window.updateTable?.();
  }

  let tipTimer = null;
  function tip(msg){
    if (!infoEl) { console.log("DailyActivities Tip: " + msg); return; }
    infoEl.textContent = msg;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(()=> infoEl.textContent = '', 1800);
  }

  // -------------------- Public API --------------------
  function init(){
    load();
    ensureMount();

    if (addBtn) {
      addBtn.addEventListener('click', onAdd);
      nameInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      startInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      endInput?.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
    } else {
      console.error("Could not find the 'Add Fixed Activity' button (#addFixedBtn).");
    }

    // Make time inputs free-text for 12h examples
    if (startInput) { startInput.type = 'text'; startInput.placeholder ||= 'e.g., 12:00pm'; }
    if (endInput)   { endInput.type = 'text';   endInput.placeholder   ||= 'e.g., 12:30pm'; }

    renderChips();
    renderList();
  }

  function onDivisionsChanged(){
    if(!rootEl) return;
    renderChips();
    renderList();
  }

  function prePlace(){
    const summary = [];
    if(!Array.isArray(window.unifiedTimes) || unifiedTimes.length===0) return summary;

    window.divisionActiveRows = window.divisionActiveRows || {};

    const divBunks = {};
    (Array.isArray(window.availableDivisions)?availableDivisions:[]).forEach(d=>{
      const b = (window.divisions && divisions[d] && Array.isArray(divisions[d].bunks)) ? divisions[d].bunks : [];
      divBunks[d] = b;
    });

    fixedActivities.filter(x=>x.enabled).forEach(item=>{
      const startMin = toMinutes(item.start), endMin = toMinutes(item.end);
      const rows = rowsForBlock(startMin,endMin);
      if(rows.length===0) return;

      const targets = resolveTargetDivisions(item.divisions);
      targets.forEach(div=>{
        if(!window.divisionActiveRows[div]) window.divisionActiveRows[div] = new Set();
        rows.forEach(r=> window.divisionActiveRows[div].add(r));

        const bunks = divBunks[div] || [];
        bunks.forEach(b => {
          if(!window.scheduleAssignments[b]) window.scheduleAssignments[b] = new Array(unifiedTimes.length);
          rows.forEach((r,idx)=>{
            window.scheduleAssignments[b][r] = {
              field: { name: item.name },
              sport: null,
              continuation: idx>0,
              _fixed: true,
              _skip: false
            };
            summary.push({ bunk:b, row:r, name:item.name });
          });
        });
      });
    });

    return summary;
  }

  function getAll(){ return JSON.parse(JSON.stringify(fixedActivities)); }
  function setAll(arr){ if(Array.isArray(arr)){ fixedActivities = arr; save(); renderList(); } }

  window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll };
  document.addEventListener('DOMContentLoaded', init);
})();
