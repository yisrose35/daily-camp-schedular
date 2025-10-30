// dailyActivities.js — Fixed Daily Activities (Lunch/Mincha/Swim/etc.)
// Integrates with globals: availableDivisions, divisions, unifiedTimes, scheduleAssignments, divisionActiveRows
// Exposes: window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll }

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
  // Removed: rootEl (no longer needed)
  let chipsWrap, listEl, nameInput, startInput, endInput, addBtn, infoEl; // Use existing elements

  // REMOVED: ensureMount function and injectStyles function (UI is already in index.html)

  function renderChips(){
    // Ensure chipsWrap is available before using it
    if (!chipsWrap) return;
    
    chipsWrap.innerHTML = '';
    const divs = Array.isArray(window.availableDivisions) ? window.availableDivisions : [];
    divs.forEach(d => {
      const el = document.createElement('span');
      // Replaced 'chip' class with 'bunk-button' which is likely defined in styles.css for consistency
      // or we can use a simpler class. Let's use 'chip' and rely on existing or future styles.
      el.className = 'chip';
      el.textContent = d;
      el.dataset.value = d;
      el.addEventListener('click', ()=> el.classList.toggle('active'));
      chipsWrap.appendChild(el);
    });
  }

  function getSelectedDivisions(){
    // Ensure chipsWrap is available before using it
    if (!chipsWrap) return [];

    return Array.from(chipsWrap.querySelectorAll('.chip.active')).map(x=>x.dataset.value);
  }

  function renderList(){
    // Ensure listEl is available before using it
    if (!listEl) return;
    
    if(!fixedActivities.length){
      listEl.innerHTML = '<div class="muted" style="color:#666;">No fixed activities yet.</div>';
      return;
    }
    listEl.innerHTML = '';
    fixedActivities.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';
      const targets = resolveTargetDivisions(item.divisions);
      const label = `${targets.join(', ') || 'All'}`;
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding: 10px 0;">
          <div>
            <div><strong>${escapeHtml(item.name)}</strong> (${to12hLabel(item.start)} - ${to12hLabel(item.end)})</div>
            <div style="color:#666; font-size: 0.9em;">Applies to: ${escapeHtml(label)}</div>
          </div>
          <div>
            <button data-act="toggle" style="background:#2ecc71; color:white; border:none; padding: 6px 10px; border-radius:4px; cursor:pointer;">${item.enabled?'Disable':'Enable'}</button>
            <button data-act="remove" style="background:#e74c3c; color:white; border:none; padding: 6px 10px; border-radius:4px; cursor:pointer; margin-left:8px;">Remove</button>
          </div>
        </div>
      `;
      row.querySelector('[data-act="toggle"]').addEventListener('click', ()=>{
        item.enabled = !item.enabled; save(); renderList();
        window.updateTable?.(); // Trigger table update on toggle
      });
      row.querySelector('[data-act="remove"]').addEventListener('click', ()=>{
        fixedActivities = fixedActivities.filter(x=>x.id!==item.id); save(); renderList();
        window.updateTable?.(); // Trigger table update on remove
      });
      listEl.appendChild(row);
    });
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function onAdd(){
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
    window.updateTable?.(); // Trigger table update on add
  }

  let tipTimer = null;
  function tip(msg){
    // If infoEl is not available, just use console for feedback
    if (!infoEl) { console.log("DailyActivities Tip: " + msg); return; }
    infoEl.textContent = msg;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(()=> infoEl.textContent = '', 1800);
  }

  // -------------------- Public API --------------------
  function init(){
    load();
    
    // --- THE CRITICAL FIX: Find existing elements by ID ---
    nameInput = document.getElementById('fixedName');
    startInput = document.getElementById('fixedStart');
    endInput = document.getElementById('fixedEnd');
    addBtn = document.getElementById('addFixedBtn');
    chipsWrap = document.getElementById('fixedDivisionsBox');
    listEl = document.getElementById('fixedList');
    // infoEl will likely remain undefined unless a feedback div is added to the HTML
    // If you want to use the tip function, you should add a hidden div with id="fixedInfo" 
    // near the "Add Fixed Activity" button in index.html

    // --- ATTACH LISTENER TO THE CORRECT BUTTON ---
    if(addBtn) {
      addBtn.addEventListener('click', onAdd);
    } else {
      console.error("Could not find the 'Add Fixed Activity' button (#addFixedBtn).");
    }

    renderChips();
    renderList();
  }

  function onDivisionsChanged(){
    // Rebuild chips if the available divisions changed at runtime
    renderChips();
    renderList();
  }
  // ... (rest of prePlace, getAll, setAll functions are unchanged) ...
  /**
   * Pre-place enabled fixed activities into the schedule grid.
   * - Sets divisionActiveRows[div] to include blocked rows.
   * - Pre-fills scheduleAssignments for every bunk in targeted divisions with a non-overwritable fixed block.
   * Return value is a summary useful for debugging.
   */
  function prePlace(){
    const summary = [];
    if(!Array.isArray(window.unifiedTimes) || unifiedTimes.length===0) return summary;

    // Ensure container exists
    window.divisionActiveRows = window.divisionActiveRows || {};

    // Build a fast map of division -> bunks
    const divBunks = {};
    (Array.isArray(window.availableDivisions)?availableDivisions:[]).forEach(d=>{
      const b = (window.divisions && divisions[d] && Array.isArray(divisions[d].bunks)) ? divisions[d].bunks : [];
      divBunks[d] = b;
    });

    // Loop over items
    fixedActivities.filter(x=>x.enabled).forEach(item=>{
      const startMin = toMinutes(item.start), endMin = toMinutes(item.end);
      const rows = rowsForBlock(startMin,endMin);
      if(rows.length===0) return; // If no full rows fit, we skip to avoid shortening a period

      const targets = resolveTargetDivisions(item.divisions);
      targets.forEach(div=>{
        // Mark division active rows
        if(!window.divisionActiveRows[div]) window.divisionActiveRows[div] = new Set();
        rows.forEach(r=> window.divisionActiveRows[div].add(r));

        // Fill scheduleAssignments with fixed blocks for each bunk of the division
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

  // Expose
  window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll };

  // Auto-init when DOM is ready (safe if included with defer)
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
