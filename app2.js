// -------------------- app2.js --------------------
// Leagues (teams != bunks) get their own assignment layer and merged cell rendering.

// ===== Helpers: time / labels =====
function parseTimeToMinutes(str){
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase(); let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) { mer = s.endsWith("am") ? "am" : "pm"; s = s.replace(/am|pm/g,"").trim(); }
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/); if(!m) return null;
  let hh = parseInt(m[1],10); const mm = parseInt(m[2],10);
  if (Number.isNaN(hh)||Number.isNaN(mm)||mm<0||mm>59) return null;
  if (mer){ if (hh===12) hh = (mer==="am")?0:12; else if (mer==="pm") hh += 12; }
  return hh*60+mm;
}
function fieldLabel(f){ if(typeof f==="string")return f; if(f&&typeof f==="object"&&typeof f.name==="string")return f.name; return ""; }

function findRowsForRange(startStr,endStr){
  if(!Array.isArray(window.unifiedTimes)||window.unifiedTimes.length===0) return [];
  const startMin=parseTimeToMinutes(startStr), endMin=parseTimeToMinutes(endStr);
  if(startMin==null||endMin==null||endMin<=startMin) return [];
  const inside=[]; for(let i=0;i<window.unifiedTimes.length;i++){
    const r=window.unifiedTimes[i], rs=r.start.getHours()*60+r.start.getMinutes(), re=r.end.getHours()*60+r.end.getMinutes();
    if(rs>=startMin && re<=endMin) inside.push(i);
  }
  if(inside.length===0){
    const overlap=[]; for(let i=0;i<window.unifiedTimes.length;i++){
      const r=window.unifiedTimes[i], rs=r.start.getHours()*60+r.start.getMinutes(), re=r.end.getHours()*60+r.end.getMinutes();
      if(Math.max(rs,startMin) < Math.min(re,endMin)) overlap.push(i);
    }
    return overlap;
  }
  return inside;
}

// ===== Fixed activities =====
function loadActiveFixedActivities(){
  let raw=localStorage.getItem("fixedActivities_v2"); if(!raw) raw=localStorage.getItem("fixedActivities");
  try{ const arr=JSON.parse(raw||"[]"); return Array.isArray(arr)?arr.filter(a=>a&&a.enabled):[]; }catch{ return []; }
}
function computeBlockedRowsByDiv(){
  const fixed=loadActiveFixedActivities(); const blocked={};
  fixed.forEach(act=>{
    const rows=findRowsForRange(act.start,act.end); if(rows.length===0) return;
    const targetDivs=(Array.isArray(act.divisions)&&act.divisions.length>0)?act.divisions:(window.availableDivisions||[]);
    targetDivs.forEach(div=>{ blocked[div]=blocked[div]||new Set(); rows.forEach(r=>blocked[div].add(r)); });
  });
  return blocked;
}
function prePlaceFixedActivities(){
  if(window.DailyActivities && typeof window.DailyActivities.prePlace==="function"){
    try{ window.DailyActivities.prePlace(); }catch(e){ console.error("DailyActivities.prePlace error:",e); }
  }
  return computeBlockedRowsByDiv();
}

// ===== League helpers =====
function leaguesSnapshot(){
  if (window.leaguesByName && Object.keys(window.leaguesByName).length>0) return window.leaguesByName;
  try{
    const raw = localStorage.getItem("leagues"); 
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj==="object") ? obj : {};
  }catch{ return {}; }
}
function getEnabledLeaguesByDivision(){
  const result = {}; // { div: { name, data }[] } but we only expect single league per div in your UI
  const all = leaguesSnapshot();
  Object.keys(all).forEach(name=>{
    const l = all[name];
    if (!l?.enabled) return;
    (l.divisions||[]).forEach(div=>{
      result[div] = { name, data: l };
    });
  });
  return result;
}

// Round-robin generator (teams are league teams, not bunks)
(function(){
  'use strict';
  const KEY="camp_league_round_state";
  let state={};
  function load(){ try{ state=JSON.parse(localStorage.getItem(KEY)||"{}")||{}; }catch{ state={}; } }
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(state)); }catch{} }
  function genRR(teams){
    if(!teams||teams.length<2) return [];
    const t=[...teams]; let bye=false;
    if(t.length%2!==0){ t.push("BYE"); bye=true; }
    const fixed=t[0], rot=t.slice(1), rounds=t.length-1, out=[];
    for(let r=0;r<rounds;r++){
      const round=[]; round.push([fixed, rot[0]]);
      for(let i=1;i<t.length/2;i++) round.push([rot[i], rot[rot.length-i]]);
      out.push(round); rot.unshift(rot.pop());
    }
    if(bye) return out.map(r=>r.filter(m=>m[0]!=="BYE"&&m[1]!=="BYE"));
    return out;
  }
  function get(leagueName, teams){
    if(!leagueName||!teams||teams.length<2) return [];
    load();
    const cur = state[leagueName]?.currentRound ?? 0;
    const full = genRR(teams);
    if(full.length===0) return [];
    const today = full[cur];
    state[leagueName] = { currentRound: (cur+1)%full.length };
    save();
    return today;
  }
  window.getLeagueMatchups = get;
  load();
})();

// ====== CORE STATE ======
window.leagueAssignments = window.leagueAssignments || {}; 
// Shape: { [division]: { [slotIndex]: { sport, matchups: [[A,B],...], leagueName } } }

function assignFieldsToBunks(){
  // Guard globals
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.availableDivisions = Array.isArray(window.availableDivisions)?window.availableDivisions:[];
  window.divisions = window.divisions || {};
  window.fields = Array.isArray(window.fields)?window.fields:[];
  window.specialActivities = Array.isArray(window.specialActivities)?window.specialActivities:[];
  window.unifiedTimes = Array.isArray(window.unifiedTimes)?window.unifiedTimes:[];
  window.divisionActiveRows = window.divisionActiveRows || {};
  window.leagueAssignments = {}; // reset each generation

  const incEl=document.getElementById("increment");
  const inc = incEl ? parseInt(incEl.value,10) : 30;
  const durationEl=document.getElementById("activityDuration");
  const activityDuration = durationEl ? parseInt(durationEl.value,10) : 30;
  const spanLen = Math.max(1, Math.ceil(activityDuration / inc));

  const availFields = fields.filter(f=>f?.available && Array.isArray(f.activities) && f.activities.length>0);
  const availSpecials = specialActivities.filter(s=>s?.available);

  const allActivities = [
    ...availFields.flatMap(f=>f.activities.map(act=>({type:"field", field:f, sport:act}))),
    ...availSpecials.map(sa=>({type:"special", field:{name:sa.name}, sport:null}))
  ];
  if (allActivities.length===0 || unifiedTimes.length===0){
    console.warn("No activities or time grid available. Aborting.");
    scheduleAssignments = {};
    return;
  }

  // Reset per-bunk grid
  scheduleAssignments = {};
  availableDivisions.forEach(div=>{
    (divisions[div]?.bunks || []).forEach(b=>{
      scheduleAssignments[b]=new Array(unifiedTimes.length);
    });
  });

  // Priority order
  const priorityDivs = [...availableDivisions].reverse();

  // Locks for general activities (NOT used for league merged rows)
  const globalResourceUsage = {};
  const occupiedFieldsBySlot = Array.from({length: unifiedTimes.length}, ()=>new Set());
  const globalActivityLock = Array.from({length: unifiedTimes.length}, ()=>new Set());
  const usedActivityKeysByBunk = {};
  const fieldsUsedByBunk = {};
  availableDivisions.forEach(div=>{
    (divisions[div]?.bunks || []).forEach(b=>{
      usedActivityKeysByBunk[b]=new Set();
      fieldsUsedByBunk[b]=new Set();
    });
  });
  const norm = s => (typeof s==="string"?s.trim().toLowerCase():null);
  const activityKey = act => {
    if (!act) return null;
    if (act.sport && typeof act.sport==="string") return `sport:${norm(act.sport)}`;
    const fname = norm(act.field && act.field.name || act.field);
    return fname ? `special:${fname}` : null;
  };
  const overlaps=(aS,aE,bS,bE)=> aS<bE && bS<aE;

  function canUseField(fieldName, start, end, s){
    if(!fieldName) return false;
    for(let k=0;k<spanLen;k++){
      const idx=s+k; if(idx>=unifiedTimes.length) break;
      if(occupiedFieldsBySlot[idx].has(fieldName)) return false;
    }
    if(globalResourceUsage[fieldName]){
      for(const r of globalResourceUsage[fieldName]) if(overlaps(start,end,r.start,r.end)) return false;
    }
    return true;
  }
  function reserveField(fieldName,start,end,s,sportName=null,currentSpanLen=spanLen){
    if(!fieldName) return;
    if(!globalResourceUsage[fieldName]) globalResourceUsage[fieldName]=[];
    globalResourceUsage[fieldName].push({start,end});
    for(let k=0;k<currentSpanLen;k++){
      const idx=s+k; if(idx>=unifiedTimes.length) break;
      occupiedFieldsBySlot[idx].add(fieldName);
      if(sportName) globalActivityLock[idx].add(norm(sportName));
    }
  }

  // Pre-place fixed activities & compute blocked rows
  const blockedRowsByDiv = prePlaceFixedActivities();

  // Lock fixed resources
  Object.keys(scheduleAssignments).forEach(bunk=>{
    const row = scheduleAssignments[bunk];
    if(!Array.isArray(row)) return;
    row.forEach((entry,s)=>{
      if(entry && entry._fixed && !entry.continuation){
        let len=1;
        for(let k=s+1;k<unifiedTimes.length;k++){
          const e2=row[k];
          if(e2 && e2._fixed && fieldLabel(e2.field)===fieldLabel(entry.field)) len++; else break;
        }
        const fieldName=fieldLabel(entry.field);
        const slotStart=unifiedTimes[s].start;
        const absEnd = new Date(slotStart.getTime()+len*inc*60000);
        reserveField(fieldName, slotStart, absEnd, s, entry.sport, len);
      }
    });
  });

  // ===== 1) PLACE LEAGUES AS MERGED CELLS =====
  const enabledByDiv = getEnabledLeaguesByDivision(); // {div:{name,data}}
  for (const div of priorityDivs) {
    const lg = enabledByDiv[div];
    if (!lg) continue;

    const activeSet = window.divisionActiveRows?.[div];
    const actSlots = (activeSet && activeSet.size>0)
      ? Array.from(activeSet)
      : window.unifiedTimes.map((_,i)=>i);

    const nonBlocked = actSlots.filter(s=>{
      if (blockedRowsByDiv[div]?.has(s)) return false;
      // also skip if any bunk already has a fixed activity here (rare)
      const used = (divisions[div]?.bunks || []).some(b => scheduleAssignments[b]?.[s]);
      return !used;
    });
    if (nonBlocked.length===0) continue;

    const chosenSlot = nonBlocked[0];
    const teams = (lg.data.teams || []).map(t=>String(t||"").trim()).filter(Boolean);
    if (teams.length < 2) {
      console.warn(`[LEAGUES] "${lg.name}" for ${div}: need at least 2 teams.`);
      continue;
    }
    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if (matchups.length === 0) continue;

    const sport = (lg.data.sports && lg.data.sports[0]) ? lg.data.sports[0] : "Leagues";
    window.leagueAssignments[div] = window.leagueAssignments[div] || {};
    window.leagueAssignments[div][chosenSlot] = { sport, matchups, leagueName: lg.name };

    // IMPORTANT: block this slot for the division so bunks won't be filled here
    blockedRowsByDiv[div] = blockedRowsByDiv[div] || new Set();
    for (let k=0; k<spanLen; k++) {
      const idx = chosenSlot + k;
      if (idx >= unifiedTimes.length) break;
      blockedRowsByDiv[div].add(idx);
    }
  }

  // ===== 2) FILL GENERAL ACTIVITIES (skip league slots for that division) =====
  const PLACEHOLDER_NAME='Special Activity Needed';
  function baseFeasible(act,bunk,slotStart,slotEnd,s,allowFieldReuse){
    const fname=fieldLabel(act?.field); if(!fname) return false;
    if(!canUseField(fname,slotStart,slotEnd,s)) return false;
    if(act.sport && globalActivityLock[s].has((act.sport||"").toLowerCase())) return false;
    const key=activityKey(act); if(key && usedActivityKeysByBunk[bunk]?.has(key)) return false;
    if(!allowFieldReuse && fieldsUsedByBunk[bunk]?.has(fname)) return false;
    return true;
  }
  function chooseActivity(bunk,slotStart,slotEnd,s){
    const absEnd=new Date(slotStart.getTime()+activityDuration*60000);
    let pool=allActivities.filter(a=>baseFeasible(a,bunk,slotStart,absEnd,s,false));
    if(pool.length>0) return pool[Math.floor(Math.random()*pool.length)];
    pool=allActivities.filter(a=>baseFeasible(a,bunk,slotStart,absEnd,s,true));
    if(pool.length>0) return pool[Math.floor(Math.random()*pool.length)];
    return {type:'special', field:{name:PLACEHOLDER_NAME}, sport:null, _placeholder:true};
  }

  for(let s=0;s<unifiedTimes.length;s++){
    const slotStart=unifiedTimes[s].start;
    const absEnd=new Date(slotStart.getTime()+activityDuration*60000);

    for(const div of priorityDivs){
      // skip if league is occupying this slot for this division
      if (window.leagueAssignments?.[div]?.[s]) continue;
      if (blockedRowsByDiv[div]?.has(s)) continue;

      const activeSet = window.divisionActiveRows?.[div];
      const isActive = activeSet ? activeSet.has(s) : true;
      if (!isActive) continue;

      for(const bunk of (divisions[div]?.bunks || [])){
        if(scheduleAssignments[bunk][s]) continue; // already fixed something here (unlikely)

        const chosen=chooseActivity(bunk,slotStart,absEnd,s);
        const fname=fieldLabel(chosen.field);
        scheduleAssignments[bunk][s]={ field: fname, sport: chosen.sport, continuation:false, isLeague:false };
        if(!chosen._placeholder){ reserveField(fname,slotStart,absEnd,s,chosen.sport); }

        for(let k=1;k<spanLen;k++){
          const idx=s+k; if(idx>=unifiedTimes.length) break;
          const nextActive = activeSet ? activeSet.has(idx) : true;
          if(!nextActive) break;
          if (window.leagueAssignments?.[div]?.[idx]) break; // don't extend into league
          if(scheduleAssignments[bunk][idx]) break;
          scheduleAssignments[bunk][idx]={ field: fname, sport: chosen.sport, continuation:true, isLeague:false };
        }

        if(!chosen._placeholder){
          const key=activityKey(chosen); if(key) usedActivityKeysByBunk[bunk].add(key);
          fieldsUsedByBunk[bunk].add(fname);
        }
      }
    }
  }

  updateTable();
  saveSchedule();
}

// ===== Rendering (merged league cells) =====
function updateTable(){
  const scheduleTab=document.getElementById("schedule");
  if(!scheduleTab) return;
  scheduleTab.innerHTML="";
  if(unifiedTimes.length===0) return;

  Object.keys(scheduleAssignments).forEach(b=>{
    if(Array.isArray(scheduleAssignments[b])) scheduleAssignments[b].forEach(e=>{ if(e) delete e._skip; });
  });

  const table=document.createElement("table");
  table.className="division-schedule";

  // Header row 1: divisions
  const thead=document.createElement("thead");
  const r1=document.createElement("tr");
  const thTime=document.createElement("th"); thTime.textContent="Time"; r1.appendChild(thTime);
  availableDivisions.forEach(div=>{
    const th=document.createElement("th");
    th.colSpan=(divisions[div]?.bunks || []).length;
    th.textContent=div; th.style.background=divisions[div]?.color || '#333'; th.style.color="#fff";
    r1.appendChild(th);
  });
  thead.appendChild(r1);

  // Header row 2: bunks
  const r2=document.createElement("tr");
  const thB=document.createElement("th"); thB.textContent="Bunk"; r2.appendChild(thB);
  availableDivisions.forEach(div=>{
    (divisions[div]?.bunks || []).forEach(b=>{ const th=document.createElement("th"); th.textContent=b; r2.appendChild(th); });
  });
  thead.appendChild(r2);
  table.appendChild(thead);

  // Body
  const tbody=document.createElement("tbody");
  for(let s=0;s<unifiedTimes.length;s++){
    const tr=document.createElement("tr");
    const tdTime=document.createElement("td"); tdTime.textContent=unifiedTimes[s].label; tr.appendChild(tdTime);

    availableDivisions.forEach(div=>{
      const bunksInDiv = (divisions[div]?.bunks || []);
      const leagueHere = window.leagueAssignments?.[div]?.[s];

      if (leagueHere) {
        // Render one merged cell across the division's bunks
        const td=document.createElement("td");
        td.colSpan = bunksInDiv.length;
        const divColor = divisions[div]?.color || '#4CAF50';
        td.style.backgroundColor = divColor;
        td.style.color = 'white';
        td.style.textAlign = 'center';
        td.style.fontWeight = '600';
        const list = leagueHere.matchups.map(m => `${m[0]} vs ${m[1]}`).join(' • ');
        td.innerHTML = `<div class="league-pill">${list}<br><span style="font-size:0.85em;opacity:0.9;">(${leagueHere.sport})</span></div>`;
        tr.appendChild(td);
      } else {
        // Normal per-bunk cells
        bunksInDiv.forEach(b=>{
          if(scheduleAssignments[b] && scheduleAssignments[b][s] && scheduleAssignments[b][s]._skip) return;
          const td=document.createElement("td");

          const activeSet = window.divisionActiveRows?.[div];
          const active = activeSet ? activeSet.has(s) : true;
          if(!active){ td.className="grey-cell"; tr.appendChild(td); return; }

          const entry=scheduleAssignments[b][s];
          if (entry && !entry.continuation) {
            let span=1;
            for(let k=s+1;k<unifiedTimes.length;k++){
              const e2=scheduleAssignments[b][k];
              const sameField=e2 && fieldLabel(e2.field)===fieldLabel(entry.field);
              const sameSport=(e2 && e2.sport)===(entry && entry.sport);
              const sameLeague=!!(e2 && e2.isLeague)===!!(entry && entry.isLeague);
              const sameFixed=!!(e2 && e2._fixed)===!!(entry && entry._fixed);
              if(!e2 || !e2.continuation || !sameField || !sameSport || !sameLeague || !sameFixed) break;
              // also stop if a league starts in the next slot for this division
              if (window.leagueAssignments?.[div]?.[k]) break;
              span++;
              scheduleAssignments[b][k]._skip = true;
            }
            td.rowSpan = span;

            if (entry._fixed) {
              td.innerHTML = `<span class="fixed-pill">${fieldLabel(entry.field)}</span>`;
              td.style.backgroundColor = '#f1f1f1';
            } else if (fieldLabel(entry.field)==="Special Activity Needed" && !entry.sport) {
              td.innerHTML = `<span class="need-special-pill" style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
            } else {
              const label=fieldLabel(entry.field);
              td.textContent = entry.sport ? `${label} – ${entry.sport}` : label;
            }
          } else if(!entry) td.textContent="";
          tr.appendChild(td);
        });
      }
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scheduleTab.appendChild(table);
}

// ===== Save / Load =====
function saveSchedule(){
  try{
    localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments));
    localStorage.setItem("leagueAssignments", JSON.stringify(window.leagueAssignments || {}));
  }catch(e){ console.error("Save schedule failed:", e); }
}
function reconcileOrRenderSaved(){
  let parsedSched=null, parsedLeague=null;
  try { parsedSched = JSON.parse(localStorage.getItem("scheduleAssignments")||"null"); } catch {}
  try { parsedLeague = JSON.parse(localStorage.getItem("leagueAssignments")||"null"); } catch {}
  if (parsedSched && typeof parsedSched==="object") window.scheduleAssignments = parsedSched;
  if (parsedLeague && typeof parsedLeague==="object") window.leagueAssignments = parsedLeague;
  updateTable();
}

function initScheduleSystem(){
  try{
    if(typeof window.loadLeagues==="function") window.loadLeagues();
    reconcileOrRenderSaved();
  }catch(e){ console.error("Init error:", e); updateTable(); }
}

window.assignFieldsToBunks = assignFieldsToBunks;
window.updateTable = updateTable;
window.initScheduleSystem = initScheduleSystem;

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initScheduleSystem);
else initScheduleSystem();
