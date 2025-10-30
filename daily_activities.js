// dailyActivities.js — Fixed Daily Activities (Lunch/Mincha/Swim/etc.)
// Integrates with globals: availableDivisions, divisions, unifiedTimes, scheduleAssignments, divisionActiveRows
// Exposes: window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll }
// - Accepts 12‑hour inputs like "12:00pm" or 24‑hour like "12:00"; stores normalized 24‑hour "HH:MM".
// - If no divisions are selected for an item, it applies to ALL available divisions.
// - prePlace() will mark divisionActiveRows and prefill scheduleAssignments with read-only blocks so the scheduler avoids them.

(function(){
  const STORAGE_KEY = "fixedActivities_v2";
  let fixedActivities = []; // { id, name, start:"HH:MM", end:"HH:MM", divisions:[string], enabled:boolean }

  // -------------------- Helpers --------------------
  function uid() { return Math.random().toString(36).slice(2,9); }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      fixedActivities = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch { fixedActivities = []; }
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(fixedActivities)); }

  function pad(n){ return (n<10?'0':'') + n; }

  // Accepts "12:00pm", "12:00 pm", "12:00", "7:05AM", returns normalized "HH:MM" (24h) or null
  function normalizeTime(str){
    if(!str) return null;
    str = String(str).trim().toLowerCase();
    // Allow placeholders like "e.g., 12:00pm" — ignore if includes letters besides am/pm
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
      if(hh===12) hh = (ampm==='am') ? 0 : 12; else hh = (ampm==='pm') ? hh+12 : hh;
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

  // Given a Date, return minutes from midnight
  function minutesOf(d){ return d.getHours()*60 + d.getMinutes(); }

  // Map a [start,end) block in minutes to unified row indices it covers
  function rowsForBlock(startMin, endMin){
    if(!Array.isArray(window.unifiedTimes)) return [];
    const rows = [];
    for(let i=0;i<unifiedTimes.length;i++){
      const row = unifiedTimes[i];
      if(!(row && row.start && row.end)) continue;
      const rs = minutesOf(new Date(row.start));
      const re = minutesOf(new Date(row.end));
      // Row is fully inside the fixed block window OR overlapping — we require full coverage to avoid shortening
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
    // --- FIX: Select the existing elements from index.html ---
    nameInput = document.getElementById('fixedName');
    startInput = document.getElementById('fixedStart');
    endInput = document.getElementById('fixedEnd');
    addBtn = document.getElementById('addFixedBtn');
    chipsWrap = document.getElementById('fixedDivisionsBox');
    listEl = document.getElementById('fixedList');
    
    // If the containing element is needed for dynamic content:
    rootEl = document.getElementById('fixed-activities'); 
    
    // Create infoEl for tips/errors if it doesn't exist (assuming it's not in index.html)
    if (!document.getElementById('da_info')) {
      infoEl = document.createElement('div');
      infoEl.id = 'da_info';
      infoEl.className = 'muted';
      // Try to insert the info element near the button for feedback
      if (addBtn && addBtn.parentElement) {
        addBtn.parentElement.appendChild(infoEl);
      } else if (rootEl) {
        rootEl.appendChild(infoEl);
      }
    } else {
      infoEl = document.getElementById('da_info');
    }

    // NOTE: The actual event listener is added in the init function.
  }

  function injectStyles(){
    if(document.getElementById('da_styles')) return;
    const css = document.createElement('style');
    css.id = 'da_styles';
    css.textContent = `
      #dailyActivitiesRoot{padding:12px;border:1px solid #e1e1e1;border-radius:12px}
      #dailyActivitiesRoot .grid2{display:grid;grid-template-columns:1fr;gap:12px}
      #dailyActivitiesRoot .time-row{display:flex;gap:8px;align-items:end}
      #dailyActivitiesRoot .stack{display:flex;flex-direction:column;gap:6px}
      #dailyActivitiesRoot input{padding:8px 10px;border:1px solid #ccc;border-radius:8px}
      #dailyActivitiesRoot .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
      #dailyActivitiesRoot .chip{padding:6px 10px;border-radius:999px;border:1px solid #bbb;cursor:pointer;user-select:none}
      #dailyActivitiesRoot .chip.active{background:#111;color:#fff;border-color:#111}
      #dailyActivitiesRoot .list .item{display:flex;justify-content:space-between;align-items:center;border:1px solid #eee;border-radius:10px;padding:10px;margin:8px 0}
      #dailyActivitiesRoot .muted{color:#666}
      #dailyActivitiesRoot .sep{opacity:.7;padding:0 6px}
      #dailyActivitiesRoot button.primary{padding:8px 12px;border:none;border-radius:8px;background:#0d6efd;color:#fff;cursor:pointer}
      #dailyActivitiesRoot .pill{padding:2px 8px;border-radius:999px;background:#f2f2f2;border:1px solid #e6e6e6;margin-left:6px;font-size:12px}
      @media(min-width:720px){ #dailyActivitiesRoot .grid2{grid-template-columns:1fr 1fr} }
    `;
    document.head.appendChild(css);
  }

  function renderChips(){
    if(!chipsWrap) return; // Ensure element is found before use
    chipsWrap.innerHTML = '';
    const divs = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    divs.forEach(d => {
      const el = document.createElement('span');
      el.className = 'chip';
      el.textContent = d;
      el.dataset.value = d;
      el.addEventListener('click', ()=> el.classList.toggle('active'));
      chipsWrap.appendChild(el);
    });
  }

  function getSelectedDivisions(){
    if(!chipsWrap) return []; // Ensure element is found before use
    return Array.from(chipsWrap.querySelectorAll('.chip.active')).map(x=>x.dataset.value);
  }

  function renderList(){
    if(!listEl) return; // Ensure element is found before use

    if(!fixedActivities.length){
      listEl.innerHTML = '<div class="muted">No fixed activities yet.</div>';
      return;
    }
    listEl.innerHTML = '';
    fixedActivities.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';
      const targets = resolveTargetDivisions(item.divisions);
      const label = `${item.name} — ${to12hLabel(item.start)} to ${to12hLabel(item.end)} \u2022 ${targets.join(', ') || 'All'}`;
      row.innerHTML = `
        <div>
          <div><strong>${escapeHtml(item.name)}</strong> <span class="pill">${item.enabled?'ENABLED':'DISABLED'}</span></div>
          <div class="muted">${escapeHtml(label)}</div>
        </div>
        <div>
          <button class="primary" data-act="toggle">${item.enabled?'Disable':'Enable'}</button>
          <button style="margin-left:8px" data-act="remove">Remove</button>
        </div>
      `;
      row.querySelector('[data-act="toggle"]').addEventListener('click', ()=>{
        item.enabled = !item.enabled; save(); renderList();
        window.updateTable?.();
      });
      row.querySelector('[data-act="remove"]').addEventListener('click', ()=>{
        fixedActivities = fixedActivities.filter(x=>x.id!==item.id); save(); renderList();
        window.updateTable?.();
      });
      listEl.appendChild(row);
    });
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function onAdd(){
    // Ensure all inputs are available
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
    // Clear chip selection on add
    chipsWrap.querySelectorAll('.chip.active').forEach(c=>c.classList.remove('active'));
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
    ensureMount(); // This selects the existing elements

    // --- FIX: Attach listener to the correct button ---
    if (addBtn) {
      addBtn.addEventListener('click', onAdd);
      // Also attach listeners to the time inputs for convenience
      if (nameInput) nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      if (startInput) startInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      if (endInput) endInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
    } else {
      console.error("Could not find the 'Add Fixed Activity' button (#addFixedBtn) to attach the event listener.");
    }

    renderChips();
    renderList();
    // The main script should trigger updateTable after init is complete if needed
  }

  function onDivisionsChanged(){
    if(!rootEl) return;
    renderChips();
    renderList();
  }

  /**
   * Pre-place enabled fixed activities into the schedule grid.
   * (Function body is unchanged)
   */
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

  // --- FIX: Expose window.DailyActivities immediately. ---
  window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll };

  // Auto-init on DOMContentLoaded, ensuring UI elements are available when init() runs.
  document.addEventListener('DOMContentLoaded', init);
})();
