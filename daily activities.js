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
    // Mount inside the Daily tab (#daily). If not found, create a minimal section at body end.
    const tab = document.getElementById('daily') || (function(){
      const sec = document.createElement('section');
      sec.id = 'daily';
      document.body.appendChild(sec);
      return sec;
    })();

    if(document.getElementById('dailyActivitiesRoot')) return;

    tab.innerHTML = tab.innerHTML; // no-op, keep existing, just append below

    rootEl = document.createElement('div');
    rootEl.id = 'dailyActivitiesRoot';
    rootEl.className = 'card';
    rootEl.innerHTML = `
      <h2>Daily Fixed Activities</h2>

      <div class="grid2">
        <label class="stack">
          <span>Name</span>
          <input id="da_name" placeholder="Lunch / Mincha / Swim" />
        </label>
        <div class="time-row">
          <label class="stack">
            <span>Start</span>
            <input id="da_start" placeholder="e.g., 12:00pm" />
          </label>
          <span class="sep">to</span>
          <label class="stack">
            <span>End</span>
            <input id="da_end" placeholder="e.g., 12:30pm" />
          </label>
        </div>
      </div>

      <div class="stack">
        <span>Applies to Divisions</span>
        <div id="da_chips" class="chips"></div>
        <small>Toggle chips to target specific divisions. Leave all unselected to apply to <b>all</b>.</small>
      </div>

      <button id="da_add" class="primary">Add Fixed Activity</button>
      <div id="da_info" class="muted" style="margin-top:8px;"></div>

      <hr />
      <div id="da_list" class="list"></div>
    `;

    tab.appendChild(rootEl);

    // Basic styles (scoped)
    injectStyles();

    chipsWrap = rootEl.querySelector('#da_chips');
    listEl   = rootEl.querySelector('#da_list');
    nameInput= rootEl.querySelector('#da_name');
    startInput= rootEl.querySelector('#da_start');
    endInput = rootEl.querySelector('#da_end');
    addBtn   = rootEl.querySelector('#da_add');
    infoEl   = rootEl.querySelector('#da_info');

    addBtn.addEventListener('click', onAdd);
    nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
    startInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
    endInput.addEventListener('keydown', e=>{ if(e.key==='Enter') onAdd(); });
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
    return Array.from(chipsWrap.querySelectorAll('.chip.active')).map(x=>x.dataset.value);
  }

  function renderList(){
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
      });
      row.querySelector('[data-act="remove"]').addEventListener('click', ()=>{
        fixedActivities = fixedActivities.filter(x=>x.id!==item.id); save(); renderList();
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
    chipsWrap.querySelectorAll('.chip.active').forEach(c=>c.classList.remove('active'));
    tip('Added.');
    renderList();
  }

  let tipTimer = null;
  function tip(msg){
    infoEl.textContent = msg;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(()=> infoEl.textContent = '', 1800);
  }

  // -------------------- Public API --------------------
  function init(){
    load();
    ensureMount();
    renderChips();
    renderList();
  }

  function onDivisionsChanged(){
    // Rebuild chips if the available divisions changed at runtime
    if(!rootEl) return; // not mounted yet
    renderChips();
    renderList();
  }

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
