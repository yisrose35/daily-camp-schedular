
// =================================================================
// locations.js
//
// Manages Transition Zones and Max Concurrent Transition Capacity 
// (Addressing Issue 2 and Issue 4).
// =================================================================
(function() {
'use strict';

let zones = {};
const DEFAULT_ZONE_NAME = "Main Campus";

function loadZones() {
    const g = window.loadGlobalSettings?.() || {};
    zones = g.locationZones || {};
    // Ensure default zone exists
    if (!zones[DEFAULT_ZONE_NAME]) {
        zones[DEFAULT_ZONE_NAME] = {
            name: DEFAULT_ZONE_NAME,
            maxConcurrent: 99, // Essentially unlimited
            isDefault: true
        };
    }
}

function saveZones() {
    window.saveGlobalSettings?.("locationZones", zones);
}

function initLocationsTab() {
    const container = document.getElementById("locations");
    if (!container) return;
    loadZones();
    renderLocationsUI(container);
}

function renderLocationsUI(container) {
    container.innerHTML = `
        <div class="setup-grid">
            <section class="setup-card setup-card-wide">
                <div class="setup-card-header">
                    <span class="setup-step-pill">Zones</span>
                    <div class="setup-card-text">
                        <h3>Transition Zones & Capacity</h3>
                        <p>
                            Group fields/activities into zones (e.g., Highpark) to enable automatic buffer merging 
                            and set transportation limits (e.g., max 2 bunks can leave at once).
                        </p>
                    </div>
                </div>

                <div style="display:flex; gap:20px; flex-wrap:wrap;">
                    <div style="flex:1; min-width:280px;">
                        <div class="setup-subtitle">All Zones</div>
                        <div id="zone-list" class="master-list" style="margin-top:10px;"></div>
                        <input id="new-zone-input" placeholder="New Zone Name (e.g., Highpark)" style="margin-top:10px; width:100%;">
                        <button id="add-zone-btn" style="width:100%; margin-top:8px; background:#007bff; color:white;">Add Zone</button>
                    </div>

                    <div id="zone-detail-pane" class="detail-pane" style="flex:1.5; min-width:350px;">
                        <p class="muted">Select a zone to set its capacity.</p>
                    </div>
                </div>
            </section>
        </div>
    `;

    const listEl = document.getElementById("zone-list");
    const detailEl = document.getElementById("zone-detail-pane");
    
    Object.values(zones).sort((a,b) => a.name.localeCompare(b.name)).forEach(z => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.textContent = z.name;
        if (z.isDefault) item.textContent += " (Default)";
        item.onclick = () => renderZoneDetail(z, detailEl, listEl);
        listEl.appendChild(item);
    });

    document.getElementById("add-zone-btn").onclick = () => {
        const name = document.getElementById("new-zone-input").value.trim();
        if (!name || zones[name]) return alert("Name required or already exists.");
        zones[name] = { name, maxConcurrent: 2 };
        saveZones();
        renderLocationsUI(container);
    };
}

let selectedZone = null;

function renderZoneDetail(zone, detailEl, listEl) {
    selectedZone = zone;
    
    // Highlight list item
    const listItems = listEl.querySelectorAll('.list-item');
    listItems.forEach(item => item.classList.remove('selected'));
    
    for (let item of listItems) {
        if (item.textContent.startsWith(zone.name)) {
            item.classList.add('selected');
            break;
        }
    }


    detailEl.innerHTML = `
        <h4 style="margin-top:0;">${zone.name} Details</h4>
        <p class="muted">This zone manages the movement for fields/activities assigned to it.</p>
        
        <div style="display:flex; align-items:center; gap:10px; margin-top:15px;">
            <label style="font-weight:600; min-width:140px;">Max Concurrent Transitions:</label>
            <input type="number" id="max-concurrent-input" value="${zone.maxConcurrent}" min="1" max="99" style="width:80px;">
        </div>
        <p class="muted" style="font-size:0.8rem; margin-top:5px; padding-left:150px;">
            This limits how many bunks can start/end a transition to/from this zone at the same time (e.g., number of buses).
        </p>
    `;

    const input = document.getElementById("max-concurrent-input");
    input.onchange = () => {
        const val = parseInt(input.value);
        if (val > 0) zone.maxConcurrent = val;
        saveZones();
    };

    if (!zone.isDefault) {
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete Zone';
        delBtn.style.cssText = 'background:#c0392b; color:white; border:none; margin-top:15px;';
        delBtn.onclick = () => {
            if (confirm(`Are you sure you want to delete the ${zone.name} zone?`)) {
                delete zones[zone.name];
                saveZones();
                renderLocationsUI(detailEl.parentElement.parentElement);
            }
        };
        detailEl.appendChild(delBtn);
    }
}

window.initLocationsTab = initLocationsTab;
window.getZones = () => zones;
window.DEFAULT_ZONE_NAME = DEFAULT_ZONE_NAME;

})();
