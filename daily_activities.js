// dailyActivities.js — Fixed Daily Activities
// (Lunch/Mincha/Swim/etc.)
// NEW: Added Pre- and Post-activity buffer times (e.g., "Changing" for Swim)
// (UPDATED to use calendar.js save/load)

(function(){
  // const STORAGE_KEY = "fixedActivities_v2"; // No longer used
  let fixedActivities = []; // { id, name, start, end, divisions, enabled, preName, preMin, postName, postMin }

  // -------------------- Helpers --------------------
  function uid() { return Math.random().toString(36).slice(2,9); }

  function load() {
    try {
      // UPDATED: Load from global settings
      const raw = window.loadGlobalSettings?.().fixedActivities;
      let parsed = Array.isArray(raw) ? raw : [];
      
      // Ensure new fields exist for old data
      fixedActivities = parsed.map(item => ({
          ...item,
          preName: item.preName || '',
          preMin: item.preMin || 0,
          postName: item.postName || '',
          postMin: item.postMin || 0,
      }));
    } catch { 
      fixedActivities = []; 
    }
  }
  function save() { 
    // UPDATED: Save to global settings
    window.saveGlobalSettings?.("fixedActivities", fixedActivities);
  }

  function pad(n){ return (n<10?'0':'') + n; }

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
    const am = h<12;
    let labelH = h%12;
    if(labelH===0) labelH=12;
    return `${labelH}:${pad(m)} ${am? 'AM':'PM'}`;
  }

  function minutesOf(d){ return d.getHours()*60 + d.getMinutes(); }

  function rowsForBlock(startMin, endMin){
    if(!Array.isArray(window.unifiedTimes)) return [];
    const rows = [];
    for(let i=0;i<window.unifiedTimes.length;i++){
      const row = unifiedTimes[i];
      if(!(row && row.start && row.end)) continue;
      const rs = minutesOf(new Date(row.start));
      const re = minutesOf(new Date(row.end));
      if(Math.max(rs, startMin) < Math.min(re, endMin)){ 
          rows.push(i); 
      }
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
  let preNameInput, preTimeInput, postNameInput, postTimeInput;
  
  function createTimeInput(id, label) {
    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '8px';
    
    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.style.display = 'block';
    lbl.style.fontWeight = '500';
    lbl.style.marginBottom = '4px';
    
    const input = document.createElement('input');
    input.type = 'number';
    input.id = id;
    input.placeholder = 'Mins';
    input.style.width = '60px';
    input.style.marginRight = '8px';
    
    const btnBox = document.createElement('span');
    [5, 10, 15].forEach(val => {
        const btn = document.createElement('button');
        btn.textContent = `${val} min`;
        btn.type = 'button'; // Prevent form submission
        btn.style.marginRight = '4px';
        btn.style.padding = '4px 8px';
        btn.style.cursor = 'pointer';
        btn.onclick = () => { input.value = val; };
        btnBox.appendChild(btn);
    });
    
    wrapper.appendChild(lbl);
    wrapper.appendChild(input);
    wrapper.appendChild(btnBox);
    return { wrapper, input };
  }

  function ensureMount(){
    nameInput = document.getElementById('fixedName');
    startInput = document.getElementById('fixedStart');
    endInput = document.getElementById('fixedEnd');
    addBtn = document.getElementById('addFixedBtn');
    chipsWrap = document.getElementById('fixedDivisionsBox');
    listEl = document.getElementById('fixedList');
    
    rootEl = document.getElementById('fixed-activities'); 
    
    if (addBtn && addBtn.parentElement && !document.getElementById('fixedPreName')) {
        const parent = addBtn.parentElement;
        
        const preNameLbl = document.createElement('label');
        preNameLbl.textContent = 'Pre-Activity Name (e.g., "Changing")';
        preNameLbl.style.display = 'block';
        preNameLbl.style.fontWeight = '500';
        preNameLbl.style.marginTop = '10px';
        preNameInput = document.createElement('input');
        preNameInput.id = 'fixedPreName';
        preNameInput.placeholder = 'Optional name';
        preNameInput.style.width = '100%';
        preNameInput.style.boxSizing = 'border-box';

        const preTime = createTimeInput('fixedPreTime', 'Pre-Activity Duration');
        preTimeInput = preTime.input;

        const postNameLbl = document.createElement('label');
        postNameLbl.textContent = 'Post-Activity Name (e.g., "Changing")';
        postNameLbl.style.display = 'block';
        postNameLbl.style.fontWeight = '500';
        postNameLbl.style.marginTop = '10px';
        postNameInput = document.createElement('input');
        postNameInput.id = 'fixedPostName';
        postNameInput.placeholder = 'Optional name';
        postNameInput.style.width = '100%';
        postNameInput.style.boxSizing = 'border-box';

        const postTime = createTimeInput('fixedPostTime', 'Post-Activity Duration');
        postTimeInput = postTime.input;
        
        parent.insertBefore(preNameLbl, addBtn);
        parent.insertBefore(preNameInput, addBtn);
        parent.insertBefore(preTime.wrapper, addBtn);
        parent.insertBefore(postNameLbl, addBtn);
        parent.insertBefore(postNameInput, addBtn);
        parent.insertBefore(postTime.wrapper, addBtn);
    } else {
        preNameInput = document.getElementById('fixedPreName');
        preTimeInput = document.getElementById('fixedPreTime');
        postNameInput = document.getElementById('fixedPostName');
        postTimeInput = document.getElementById('fixedPostTime');
    }
    
    if (!document.getElementById('da_info')) {
      infoEl = document.createElement('div');
      infoEl.id = 'da_info';
      infoEl.className = 'muted';
      if (addBtn && addBtn.parentElement) {
        addBtn.parentElement.appendChild(infoEl);
      } else if (rootEl) {
        rootEl.appendChild(infoEl);
      }
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
      el.className = 'bunk-button'; 
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
      const targets = resolveTargetDivisions(item.divisions);
      const label = `${targets.join(', ') || 'All'}`;
      
      let details = `<div class="muted" style="font-size: 0.9em;">Total: ${to12hLabel(item.start)} - ${to12hLabel(item.end)} &bull; Applies to: ${escapeHtml(label)}</div>`;

      if (item.preMin > 0) {
        const preLabel = item.preName || 'Preparation';
        details += `<div class="muted" style="font-size: 0.8em; padding-left: 10px;">&hookrightarrow; <strong>${escapeHtml(preLabel)}:</strong> First ${item.preMin} mins</div>`;
      }
      if (item.postMin > 0) {
        const postLabel = item.postName || 'Cleanup';
        details += `<div class="muted" style="font-size: 0.8em; padding-left: 10px;">&hookrightarrow; <strong>${escapeHtml(postLabel)}:</strong> Last ${item.postMin} mins</div>`;
      }
      
      row.innerHTML = `
        <div style="flex-grow:1;">
          <div><strong>${escapeHtml(item.name)}</strong></div>
          ${details}
        </div>
        <div style="display:flex; align-items:center; gap:15px;">
          <label class="switch"> 
            <input type="checkbox" ${item.enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <button data-act="remove" style="padding: 6px 10px; border-radius:4px; cursor:pointer;">Remove</button>
        </div>
      `;
      
      row.querySelector('input[type="checkbox"]').addEventListener('change', (e)=>{
        item.enabled = e.target.checked; 
        save(); 
        renderList(); 
        window.updateTable?.();
      });
      
      row.querySelector('[data-act="remove"]').addEventListener('click', ()=>{
        fixedActivities = fixedActivities.filter(x=>x.id!==item.id);
        save();
        renderList();
        window.updateTable?.();
      });
      listEl.appendChild(row);
    });
  }
  
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
  
  function onAdd(){
    if(!nameInput || !startInput || !endInput) return tip('UI elements not found. Initialization failed.');
  
    const name = (nameInput.value||'').trim();
    const ns = normalizeTime(startInput.value);
    const ne = normalizeTime(endInput.value);
    if(!name){ return tip('Please enter a name.'); }
    if(!ns || !ne){ return tip('Please enter valid start and end times (e.g., 12:00pm).'); }
    
    const ms = toMinutes(ns), me = toMinutes(ne);
    if(me<=ms){ return tip('End must be after start.'); }

    const preName = (preNameInput.value || '').trim() || name;
    const preMin = parseInt(preTimeInput.value) || 0;
    const postName = (postNameInput.value || '').trim() || name;
    const postMin = parseInt(postTimeInput.value) || 0;

    if ((preMin + postMin) >= (me - ms)) {
        return tip('Buffer times cannot be longer than the total activity duration.');
    }

    const divisionsSel = getSelectedDivisions();
    
    fixedActivities.push({ 
        id:uid(), 
        name, 
        start:ns, 
        end:ne, 
        divisions:divisionsSel, 
        enabled:true,
        preName: preName,
        preMin: preMin,
        postName: postName,
        postMin: postMin
    });
    
    save();
    nameInput.value = ''; startInput.value = ''; endInput.value = '';
    preNameInput.value = ''; preTimeInput.value = '';
    postNameInput.value = ''; postTimeInput.value = '';
    
    chipsWrap.querySelectorAll('.bunk-button.selected').forEach(c=>c.classList.remove('selected'));
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
      if (nameInput) nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      if (startInput) startInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
      if (endInput) endInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
    } else {
      console.error("Could not find the 'Add Fixed Activity' button (#addFixedBtn) to attach the event listener.");
    }
  
    renderChips();
    renderList();
  }
  
  function onDivisionsChanged(){
    if(!rootEl) return;
    renderChips();
    renderList();
  }
  
  /**
   * Pre-place enabled fixed activities into the schedule grid.
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
  
    // UPDATED: Must load the 'fixedActivities' from the global store
    // This function runs *after* app1.js loads, but *before* this file's init()
    // so we need to call load() again to be safe.
    load();
    
    fixedActivities.filter(x=>x.enabled).forEach(item => {
      const totalStartMin = toMinutes(item.start);
      const totalEndMin = toMinutes(item.end);
      const allRows = rowsForBlock(totalStartMin, totalEndMin);
      if(allRows.length===0) return;

      const preName = item.preName || item.name;
      const postName = item.postName || item.name;
      const preMin = item.preMin || 0;
      const postMin = item.postMin || 0;

      const preEndMin = totalStartMin + preMin;
      const postStartMin = totalEndMin - postMin;

      const targets = resolveTargetDivisions(item.divisions);
      targets.forEach(div=>{
        if(!window.divisionActiveRows[div]) window.divisionActiveRows[div] = new Set();
        allRows.forEach(r=> window.divisionActiveRows[div].add(r));
  
        const bunks = divBunks[div] || [];
        bunks.forEach(b => {
          if(!window.scheduleAssignments[b]) window.scheduleAssignments[b] = new Array(unifiedTimes.length);
          
          let previousActivityName = null; 
          
          allRows.forEach((r, idx)=>{
            const row = unifiedTimes[r];
            const rs = minutesOf(new Date(row.start)); 
            
            let currentActivityName = item.name; 
            
            if (preMin > 0 && rs < preEndMin) {
                currentActivityName = preName;
            } else if (postMin > 0 && rs >= postStartMin) {
                currentActivityName = postName;
            }
            
            window.scheduleAssignments[b][r] = {
              field: { name: currentActivityName },
              sport: null,
              continuation: (idx > 0 && currentActivityName === previousActivityName),
              _fixed: true,
              _skip: false
            };
            summary.push({ bunk:b, row:r, name:currentActivityName });
            previousActivityName = currentActivityName; 
          });
        });
      });
    });
  
    return summary;
  }
  
  function getAll(){ return JSON.parse(JSON.stringify(fixedActivities)); }
  function setAll(arr){ if(Array.isArray(arr)){ fixedActivities = arr; save(); renderList(); } }
  
  // Expose window.DailyActivities immediately.
  window.DailyActivities = { init, onDivisionsChanged, prePlace, getAll, setAll };
  
  // Auto-init on DOMContentLoaded
  // (This is now handled by index.html's boot() function)
  // document.addEventListener('DOMContentLoaded', init);
})();
