// -------------------- Scheduling Core (Unified Grid)
--------------------
function assignFieldsToBunks() {
  const availFields =
fields.filter(f => f.available && f.activities.length > 0);
  const availSpecials
= specialActivities.filter(s => s.available);
 
  const allActivities
= [
   ...availFields.flatMap(f => f.activities.map(act => ({ type:
"field", field: f, sport: act }))),
   ...availSpecials.map(sa => ({ type: "special", field: {
name: sa.name }, sport: null }))
  ];
  if
(allActivities.length === 0) {
    alert("No
activities available.");
   scheduleAssignments = {};
    return;
  }
 
  // Reset schedules
  scheduleAssignments
= {};
 availableDivisions.forEach(div => {
   divisions[div].bunks.forEach(b => { scheduleAssignments[b] = new
Array(unifiedTimes.length); });
  });
 
  const inc =
parseInt(document.getElementById("increment").value, 10);
  const spanLen =
Math.max(1, Math.ceil(activityDuration / inc));

// -------------------- Fixed Daily Activity Reservation (NEW SECTION) --------------------
dailyActivities.forEach(act => {
   const actStart = parseTime(act.start);
   const actEnd = parseTime(act.end);

   if (!actStart || !actEnd) return; // Skip invalid times

   unifiedTimes.forEach((timeSlot, s) => {
     // Check if the time slot is covered by the fixed activity
     if (timeSlot.start >= actStart && timeSlot.end <= actEnd) {
       // Assign this activity to ALL bunks/divisions
       availableDivisions.forEach(div => {
         if (divisionActiveRows[div] && divisionActiveRows[div].has(s)) {
           divisions[div].bunks.forEach(bunk => {
             // Only assign if the spot is currently empty (not already a fixed activity)
             if (!scheduleAssignments[bunk] || !scheduleAssignments[bunk][s]) {
               scheduleAssignments[bunk][s] = {
                 field: act.name,
                 sport: null,
                 continuation: false, 
                 isLeague: false
               };
             }
           });
         }
       });
     }
   });
});
// -------------------- End Fixed Daily Activity Reservation --------------------
 
  //
  // -------------------- Global resource reservations (time-based)
  // --------------------
  const resourceUsage
= {}; // { resourceKey: [ {start:Date, end:Date} ] }
 
  function
overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart <
bEnd && bStart < aEnd;
  }
 
  function
canUseResource(resourceKey, startTime, endTime) {
    if
(!resourceUsage[resourceKey]) return true;
    return
!resourceUsage[resourceKey].some(r => overlaps(startTime, endTime, r.start,
r.end));
  }
 
  function
reserveResource(resourceKey, startTime, endTime) {
    if
(!resourceUsage[resourceKey]) resourceUsage[resourceKey] = [];
   resourceUsage[resourceKey].push({ start: startTime, end: endTime });
  }
 
  //
  // -------------------- Choose exactly ONE league slot per enabled division
  // --------------------
  const
leagueSlotByDiv = {};
 availableDivisions.forEach(div => {
    if (leagues[div]
&& leagues[div].enabled) {
      const active =
Array.from(divisionActiveRows[div] || []);
      // Filter out rows already taken by a fixed daily activity
      const availableForLeague = active.filter(s => {
        // Check if ALL bunks in this division are free at time slot s
        return divisions[div].bunks.every(bunk => 
          !(scheduleAssignments[bunk] && scheduleAssignments[bunk][s])
        );
      });

      if
(availableForLeague.length > 0) {
       leagueSlotByDiv[div] = availableForLeague[Math.floor(Math.random() *
availableForLeague.length)];
      }
    }
  });
 
  //
  // -------------------- Build schedule --------------------
  for (let s = 0; s
< unifiedTimes.length; s++) {
    const startTime =
unifiedTimes[s].start;
    const endTime =
new Date(startTime.getTime() + activityDuration * 60000);
 
    const
usedFieldsByDiv = {};
   availableDivisions.forEach(div => { usedFieldsByDiv[div] = new Set();
});
 
    for (let div of
availableDivisions) {
      if
(!(divisionActiveRows[div] && divisionActiveRows[div].has(s)))
continue;
 
      for (let bunk of
divisions[div].bunks) {
        // Skip if already assigned by fixed activity (or previous assignment)
        if
(scheduleAssignments[bunk][s]) continue;
        
        // ---- League
slot handling ----
        if
(leagueSlotByDiv[div] === s) {
         scheduleAssignments[bunk][s] = { field: "Leagues", sport:
null, continuation: false, isLeague: true };
          let placed =
1;
          while
(placed < spanLen && (s + placed) < unifiedTimes.length
&& divisionActiveRows[div].has(s + placed)
            // IMPORTANT: Check the time slot is not a fixed activity
            && (!scheduleAssignments[bunk][s + placed])
          ) {
           scheduleAssignments[bunk][s + placed] = { field: "Leagues",
sport: null, continuation: true, isLeague: true };
            placed++;
          }
          continue;
        }
 
        // ----
Continuation of previous activity ----
        let lastIdx =
s - 1, lastEntry = null;
        while (lastIdx
>= 0 && !scheduleAssignments[bunk][lastIdx]) lastIdx--;
        if (lastIdx
>= 0) lastEntry = scheduleAssignments[bunk][lastIdx];
 
        if (lastEntry
&& !lastEntry.continuation) {
          let
countDone = 1, t = lastIdx + 1;
          while (t
< s && scheduleAssignments[bunk][t] &&
scheduleAssignments[bunk][t].continuation) { countDone++; t++; }
          if
(countDone < spanLen) {
           scheduleAssignments[bunk][s] = {
              field:
lastEntry.field,
              sport:
lastEntry.sport,
             continuation: true,
             isLeague: lastEntry.isLeague || false
            };
           usedFieldsByDiv[div].add(lastEntry.field);
            continue;
          }
        }
 
        // ---- Pick a
new activity ----
        let candidates
= allActivities.filter(c => {
          if
(usedFieldsByDiv[div].has(c.field.name)) return false;
          const
resourceKey = c.field.name;
          return
canUseResource(resourceKey, startTime, endTime);
        });
 
        // Avoid
back-to-back same resource
        candidates =
candidates.filter(c => {
          if
(!lastEntry) return true;
          if
(lastEntry.isLeague) {
            if
(c.field.name === "Leagues") return false;
            if (c.type
=== "field" && c.field.name === lastEntry.field) return
false;
          }
          if (c.type
=== "field" && lastEntry.sport && c.sport ===
lastEntry.sport) return false;
          if
(c.field.name === lastEntry.field) return false;
          return true;
        });
 
        // Fallback:
ensure something is always assigned
        if
(candidates.length === 0) candidates = allActivities;
 
        let chosen =
candidates[Math.floor(Math.random() * candidates.length)];
       scheduleAssignments[bunk][s] = { field: chosen.field.name, sport:
chosen.sport, continuation: false, isLeague: false };
       usedFieldsByDiv[div].add(chosen.field.name);
 
        // Reserve
globally
       reserveResource(chosen.field.name, startTime, endTime);
 
        // Mark
continuations
        let placed =
1;
        while (placed
< spanLen && (s + placed) < unifiedTimes.length &&
divisionActiveRows[div].has(s + placed)
          // IMPORTANT: Check the time slot is not a fixed activity
          && (!scheduleAssignments[bunk][s + placed])
        ) {
         scheduleAssignments[bunk][s + placed] = { field: chosen.field.name,
sport: chosen.sport, continuation: true, isLeague: false };
          placed++;
        }
      }
    }
  }
}
 
// -------------------- Rendering (Unified Grid + Merged
Cells) --------------------
function updateTable() {
  const scheduleTab =
document.getElementById("schedule");
 scheduleTab.innerHTML = "";
  if
(unifiedTimes.length === 0) return;
 
 Object.keys(scheduleAssignments).forEach(b => {
    if
(Array.isArray(scheduleAssignments[b])) {
     scheduleAssignments[b].forEach(e => { if (e) delete e._skip; });
    }
  });
 
  const table =
document.createElement("table");
  table.className =
"division-schedule";
 
  const thead =
document.createElement("thead");
  const row1 =
document.createElement("tr");
  const thTime =
document.createElement("th"); thTime.textContent = "Time";
row1.appendChild(thTime);
 availableDivisions.forEach(div => {
    const th = document.createElement("th");
    th.colSpan =
divisions[div].bunks.length || 1;
    th.textContent =
div;
   th.style.background = divisions[div].color; th.style.color =
"#fff";
   row1.appendChild(th);
  });
 thead.appendChild(row1);
 
  const row2 =
document.createElement("tr");
  const thBunkLabel =
document.createElement("th"); thBunkLabel.textContent =
"Bunk"; row2.appendChild(thBunkLabel);
 availableDivisions.forEach(div => {
   divisions[div].bunks.forEach(b => {
      const th =
document.createElement("th"); th.textContent = b;
row2.appendChild(th);
    });
  });
 thead.appendChild(row2);
 table.appendChild(thead);
 
  const tbody =
document.createElement("tbody");
 
  for (let s = 0; s
< unifiedTimes.length; s++) {
    const tr =
document.createElement("tr");
    const tdTime =
document.createElement("td"); tdTime.textContent =
unifiedTimes[s].label; tr.appendChild(tdTime);
 
   availableDivisions.forEach(div => {
      const activeSet
= divisionActiveRows[div] || new Set();
     divisions[div].bunks.forEach(bunk => {
        if
(scheduleAssignments[bunk] && scheduleAssignments[bunk][s] &&
scheduleAssignments[bunk][s]._skip) return;
 
        const td =
document.createElement("td");
        const isActive
= activeSet.has(s);
 
        if (!isActive)
{
          td.className
= "grey-cell";
         tr.appendChild(td);
          return;
        }
 
        const entry =
scheduleAssignments[bunk] ? scheduleAssignments[bunk][s] : null;
        if (entry
&& !entry.continuation) {
          let span =
1;
          for (let k =
s + 1; k < unifiedTimes.length; k++) {
            const e2 =
scheduleAssignments[bunk][k];
            
            // Check if the activity is the same AND it's a continuation OR a fixed activity that spans multiple slots
            const isContinuationOrFixedSpan = e2 && (
              (e2.continuation && e2.field === entry.field && e2.sport === entry.sport && e2.isLeague === entry.isLeague) ||
              (e2.field === entry.field && !entry.sport && !e2.sport && !e2.continuation && !entry.isLeague && !e2.isLeague)
            );
            
            if (!isContinuationOrFixedSpan) break;

            span++;
           scheduleAssignments[bunk][k]._skip = true;
          }
          td.rowSpan =
span;
          if
(entry.isLeague) {
           td.innerHTML = `<span
class="league-pill">Leagues</span>`;
          } else {
           td.textContent = entry.sport ? `${entry.field} – ${entry.sport}` :
entry.field;
          }
        } else if
(!entry) {
         td.textContent = "";
        }
       tr.appendChild(td);
      });
    });
 
    tbody.appendChild(tr);
  }
 
 table.appendChild(tbody);
 scheduleTab.appendChild(table);
}
