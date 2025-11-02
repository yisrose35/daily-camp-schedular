// -------------------- app2.js --------------------
// Scheduling Core: Leagues + Fixed Activities + Robust fallbacks

// ---------- Small helpers ----------
function parseTimeToMinutes(str){ /* (same as before) */ 
  if (!str || typeof str !== "string") return null;
  let s = str.trim().toLowerCase(); let mer = null;
  if (s.endsWith("am") || s.endsWith("pm")) { mer = s.endsWith("am") ? "am":"pm"; s = s.replace(/am|pm/g,"").trim(); }
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

// ---------- Fixed activities ----------
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

// ---------- Leagues fallbacks ----------
function readLeaguesFromStorage(){
  try{
    const raw = localStorage.getItem("leagues");
    const obj = raw ? JSON.parse(raw) : {};
    if(obj && typeof obj==="object") return obj;
  }catch(e){ console.warn("[LEAGUES] Failed to parse localStorage:", e); }
  return {};
}
function leaguesSnapshot(){
  // prefer the published window copy; fall back to storage if missing
  if (window.leaguesByName && Object.keys(window.leaguesByName).length>0) return window.leaguesByName;
  const fromLS = readLeaguesFromStorage();
  if (Object.keys(fromLS).length>0){
    console.info("[LEAGUES] Using leagues from localStorage fallback.");
    return fromLS;
  }
  return {};
}
function getLeagueForDivision(div){
  const allLeagues = leaguesSnapshot();
  for (const name in allLeagues){
    const lg = allLeagues[name];
    if (lg?.enabled && Array.isArray(lg.divisions) && lg.divisions.includes(div)){
      return { ...lg, name }; // attach name for getLeagueMatchups
    }
  }
  return null;
}
function activeSlotsForDivision(div){
  const set = window.divisionActiveRows?.[div];
  if (set && set.size>0) return Array.from(set);
  // Fallback: treat all rows as active so leagues can place
  if (Array.isArray(window.unifiedTimes)) {
    console.info(`[LEAGUES] No active rows for "${div}". Using all time rows as fallback.`);
    return window.unifiedTimes.map((_,i)=>i);
  }
  return [];
}

// ---------- Main scheduling ----------
function assignFieldsToBunks(){
  // globals
  window.scheduleAssignments = window.scheduleAssignments || {};
  window.availableDivisions = Array.isArray(window.availableDivisions)?window.availableDivisions:[];
  window.divisions = window.divisions || {};
  window.fields = Array.isArray(window.fields)?window.fields:[];
  window.specialActivities = Array.isArray(window.specialActivities)?window.specialActivities:[];
  window.unifiedTimes = Array.isArray(window.unifiedTimes)?window.unifiedTimes:[];
  window.divisionActiveRows = window.divisionActiveRows || {};

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
    console.warn("[LEAGUES] No activities or no time grid. Aborting.");
    scheduleAssignments = {};
    return;
  }

  // Reset scaffold
  scheduleAssignments = {};
  availableDivisions.forEach(div=>{
    (divisions[div]?.bunks || []).forEach(b=>{
      scheduleAssignments[b]=new Array(unifiedTimes.length);
    });
  });

  const priorityDivs = [...availableDivisions].reverse();

  // Locks
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

  // Step 0: fixed activities
  const blockedRowsByDiv = prePlaceFixedActivities();

  // lock fixed resources
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
        const absEnd = new Date(slotStart.getTime()+len* (document.getElementById("increment")?parseInt(document.getElementById("increment").value,10):30)*60000);
        reserveField(fieldName, slotStart, absEnd, s, entry.sport, len);
      }
    });
  });

  // Step 1: Guaranteed leagues
  console.info("[LEAGUES] Starting league placement.");
  priorityDivs.forEach(div=>{
    const lg = getLeagueForDivision(div);
    if(!lg){ console.info(`[LEAGUES] Division "${div}": no enabled league.`); return; }

    const actSlots = activeSlotsForDivision(div);
    if(actSlots.length===0){ console.info(`[LEAGUES] Division "${div}": no slots.`); return; }

    const nonBlocked = actSlots.filter(s=>{
      if(blockedRowsByDiv[div]?.has(s)) return false;
      const anyAssigned = (divisions[div]?.bunks || []).some(b=> scheduleAssignments[b] && scheduleAssignments[b][s]);
      return !anyAssigned;
    });
    if(nonBlocked.length===0){ console.info(`[LEAGUES] Division "${div}": all slots blocked/used.`); return; }

    const chosenSlot = nonBlocked[0];
    const teams = lg.teams.length>0 ? lg.teams : (divisions[div]?.bunks || []);
    if(teams.length<2){ console.warn(`[LEAGUES] Division "${div}": not enough teams.`); return; }

    const matchups = window.getLeagueMatchups?.(lg.name, teams) || [];
    if(matchups.length===0){ console.warn(`[LEAGUES] Division "${div}": no matchups.`); return; }

    const chosenSport = lg.sports.length>0 ? lg.sports[0] : "Leagues";
    const leagueFieldName = "League Game (TBD)";

    matchups.forEach(([A,B])=>{
      if (A==="BYE"||B==="BYE") return;
      const playingBunks = [A,B].filter(t => (divisions[div]?.bunks || []).includes(t));
      if (playingBunks.length<2) return;

      const details = { field: leagueFieldName, sport: chosenSport, matchup: `${playingBunks[0]} vs ${playingBunks[1]}`, isLeague: true, continuation:false };
      playingBunks.forEach(b=>{
        if (!scheduleAssignments[b] || scheduleAssignments[b][chosenSlot]) return;
        scheduleAssignments[b][chosenSlot] = { ...details };
        for(let k=1;k<spanLen;k++){
          const idx=chosenSlot+k; if(idx>=unifiedTimes.length) break;
          if(!(window.divisionActiveRows?.[div]?.has(idx))) break;
          if(scheduleAssignments[b][idx]) break;
          scheduleAssignments[b][idx] = { ...details, continuation:true };
        }
      });
    });

    console.info(`[LEAGUES] Placed league for "${div}" at slot ${chosenSlot}.`);
    // Not reserving a real field; rendering shows a pill.
  });

  // Step 2: fill rest
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
      if(!(activeSlotsForDivision(div).includes(s))) continue;
      for(const bunk of (divisions[div]?.bunks || [])){
        if(scheduleAssignments[bunk][s]) continue;
        const chosen=chooseActivity(bunk,slotStart,absEnd,s);
        const fname=fieldLabel(chosen.field);
        scheduleAssignments[bunk][s]={ field: fname, sport: chosen.sport, continuation:false, isLeague:false };
        if(!chosen._placeholder){ reserveField(fname,slotStart,absEnd,s,chosen.sport); }
        for(let k=1;k<spanLen;k++){
          const idx=s+k; if(idx>=unifiedTimes.length) break;
          if(!(activeSlotsForDivision(div).includes(idx))) break;
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

// ---------- Rendering ----------
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
  const thead=document.createElement("thead");
  const row1=document.createElement("tr");
  const thTime=document.createElement("th"); thTime.textContent="Time"; row1.appendChild(thTime);

  availableDivisions.forEach(div=>{
    const th=document.createElement("th");
    th.colSpan=(divisions[div]?.bunks || []).length;
    th.textContent=div; th.style.background=divisions[div]?.color || '#333'; th.style.color="#fff";
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  const row2=document.createElement("tr");
  const thB=document.createElement("th"); thB.textContent="Bunk"; row2.appendChild(thB);
  availableDivisions.forEach(div=>{
    (divisions[div]?.bunks || []).forEach(b=>{ const th=document.createElement("th"); th.textContent=b; row2.appendChild(th); });
  });
  thead.appendChild(row2);
  table.appendChild(thead);

  const tbody=document.createElement("tbody");
  for(let s=0;s<unifiedTimes.length;s++){
    const tr=document.createElement("tr");
    const tdTime=document.createElement("td"); tdTime.textContent=unifiedTimes[s].label; tr.appendChild(tdTime);

    availableDivisions.forEach(div=>{
      const activeSet = new Set(activeSlotsForDivision(div));
      (divisions[div]?.bunks || []).forEach(b=>{
        if(scheduleAssignments[b] && scheduleAssignments[b][s] && scheduleAssignments[b][s]._skip) return;
        const td=document.createElement("td");
        const active=activeSet.has(s);
        if(!active){ td.className="grey-cell"; tr.appendChild(td); return; }

        const entry=scheduleAssignments[b][s];
        if(entry && !entry.continuation){
          let span=1;
          for(let k=s+1;k<unifiedTimes.length;k++){
            const e2=scheduleAssignments[b][k];
            const sameField=e2 && fieldLabel(e2.field)===fieldLabel(entry.field);
            const sameSport=(e2 && e2.sport)===(entry && entry.sport);
            const sameLeague=!!(e2 && e2.isLeague)===!!(entry && entry.isLeague);
            const sameFixed=!!(e2 && e2._fixed)===!!(entry && entry._fixed);
            if(!e2 || !e2.continuation || !sameField || !sameSport || !sameLeague || !sameFixed) break;
            span++; scheduleAssignments[b][k]._skip=true;
          }
          td.rowSpan=span;

          if(entry.isLeague){
            const display = entry.matchup 
              ? `<span style="font-weight:600;">${entry.matchup}</span><br><span style="font-size:0.8em;opacity:0.8;">(${entry.sport})</span>`
              : 'Leagues';
            td.innerHTML = `<div class="league-pill">${display}</div>`;
            const divColor = divisions[div]?.color || '#4CAF50';
            td.style.backgroundColor = divColor; td.style.color = 'white';
          } else if(entry._fixed){
            td.innerHTML = `<span class="fixed-pill">${fieldLabel(entry.field)}</span>`;
            td.style.backgroundColor = '#f1f1f1';
          } else if(fieldLabel(entry.field)==="Special Activity Needed" && !entry.sport){
            td.innerHTML = `<span class="need-special-pill" style="color:#c0392b;">${fieldLabel(entry.field)}</span>`;
          } else {
            const label=fieldLabel(entry.field);
            td.textContent = entry.sport ? `${label} – ${entry.sport}` : label;
          }
        } else if(!entry) td.textContent="";
        tr.appendChild(td);
      });
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scheduleTab.appendChild(table);
}

// ---------- Save/Load ----------
function saveSchedule(){ try{ localStorage.setItem("scheduleAssignments", JSON.stringify(scheduleAssignments)); }catch(e){ console.error("saveSchedule failed:",e); } }
function reconcileOrRenderSaved(){
  const saved=localStorage.getItem("scheduleAssignments");
  if(!saved){ updateTable(); return; }
  let parsed; try{ parsed=JSON.parse(saved); }catch{ parsed=null; }
  if(!parsed || typeof parsed!=="object"){ updateTable(); return; }

  const blocked=computeBlockedRowsByDiv();
  let conflict=false;
  Object.keys(parsed).forEach(bunk=>{
    const div=Object.keys(divisions).find(d=>(divisions[d]?.bunks || []).includes(bunk));
    if(!div) return;
    (parsed[bunk]||[]).forEach((cell,idx)=>{ if(cell && !cell._fixed && blocked[div] && blocked[div].has(idx)) conflict=true; });
  });
  if(conflict){ console.log("Fixed conflict detected. Regenerating."); assignFieldsToBunks(); }
  else { window.scheduleAssignments=parsed; updateTable(); }
}

function initScheduleSystem(){
  try{
    // Best effort to have leagues available
    if(typeof window.loadLeagues==="function") window.loadLeagues();
    else console.info("[LEAGUES] Leagues.js not yet loaded; will use localStorage fallback.");
    reconcileOrRenderSaved();
  }catch(e){ console.error("initScheduleSystem error:", e); updateTable(); }
}

window.assignFieldsToBunks=assignFieldsToBunks;
window.updateTable=updateTable;
window.initScheduleSystem=initScheduleSystem;

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initScheduleSystem);
else initScheduleSystem();

// ---------- Round-robin helper (same as before) ----------
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
    const fixed=t[0], rot=t.slice(1), rounds=t.length-1, sched=[];
    for(let r=0;r<rounds;r++){
      const round=[]; round.push([fixed, rot[0]]);
      for(let i=1;i<t.length/2;i++){ round.push([rot[i], rot[rot.length-i]]); }
      sched.push(round); rot.unshift(rot.pop());
    }
    if(bye) return sched.map(r=>r.filter(m=>m[0]!=="BYE"&&m[1]!=="BYE"));
    return sched;
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
  window.getLeagueMatchups=get;
  load();
})();
