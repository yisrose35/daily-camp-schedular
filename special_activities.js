
// =================================================================
// special_activities.js  — Modern Pro Camp THEMED VERSION
//
// ✦ Data still comes from:
//      window.getGlobalSpecialActivities()
//      window.saveGlobalSpecialActivities()
//
// ✦ NO LOGIC CHANGES — visual/UI theme only
//
// ✦ UPDATE: Max Usage now includes Frequency (Weeks)
// =================================================================

(function() {
'use strict';

let specialActivities = [];
let selectedItemId = null;

let specialsListEl = null;
let detailPaneEl = null;
let addSpecialInput = null;

/*********************************************************
 * INIT TAB
 *********************************************************/
function initSpecialActivitiesTab() {
    const container = document.getElementById("special_activities");
    if (!container) return;

    specialActivities = window.getGlobalSpecialActivities?.() || [];

    // ensure data completeness
    specialActivities.forEach(s => {
        s.available = s.available !== false;
        s.timeRules = s.timeRules || [];
        s.sharableWith = s.sharableWith || { type: 'not_sharable', divisions: [] };
        s.limitUsage = s.limitUsage || { enabled: false, divisions: {} };
        // Ensure maxUsage is number or null
        s.maxUsage = (s.maxUsage !== undefined && s.maxUsage !== "") ? s.maxUsage : null;
        // Ensure frequency is set (default 0 = lifetime/unlimited period)
        s.frequencyWeeks = s.frequencyWeeks || 0; 
    });

    // ==== THEMED HTML SHELL ====
    container.innerHTML = `
        <div class="setup-grid">

            <section class="setup-card setup-card-wide">

                <div class="setup-card-header">
                    <span class="setup-step-pill">Specials</span>
                    <div class="setup-card-text">
                        <h3>Special Activities & Rotations</h3>
                        <p>
                            Add canteen, electives, trips, lakes, buses, and control
                            availability, sharing, division access, and rotation rules.
                        </p>
                    </div>
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:22px; margin-top:10px;">

                    <div style="flex:1; min-width:260px;">
                        <div class="setup-subtitle">All Specials</div>
                        <p style="font-size:0.8rem; color:#6b7280;">
                            Click a special to edit its rules.
                        </p>

                        <div class="setup-field-row" style="margin-top:10px;">
                            <input id="new-special-input" placeholder="New Special (e.g., Canteen)">
                            <button id="add-special-btn">Add Special</button>
                        </div>

                        <div id="specials-master-list"
                             class="master-list"
                             style="margin-top:10px; max-height:460px; overflow:auto;">
                        </div>
                    </div>

                    <div style="flex:1.3; min-width:330px;">
                        <div class="setup-subtitle">Special Details</div>
                        <div id="specials-detail-pane"
                             class="detail-pane"
                             style="margin-top:10px; min-height:380px;">
                            <p class="muted">Select a special to begin.</p>
                        </div>
                    </div>

                </div>
            </section>
        </div>

        <style>
            .master-list {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                background: #F8FAFC;
                padding: 6px 6px;
                box-shadow: 0 8px 20px rgba(15,23,42,0.06);
            }
            .master-list .list-item {
                padding: 10px 12px;
                border-radius: 14px;
                margin-bottom: 6px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;

                background: #ffffff;
                border: 1px solid #e5e7eb;
                box-shadow: 0 3px 8px rgba(15,23,42,0.05);
                transition: 0.15s ease;
            }
            .master-list .list-item:hover {
                background: #f1f5f9;
                transform: translateY(-1px);
            }
            .master-list .list-item.selected {
                background: radial-gradient(circle at top left, #ECFDF5, #ffffff 70%);
                border-color: #00C896;
                box-shadow: 0 0 0 2px rgba(0,200,150,0.45);
                font-weight: 600;
            }

            .detail-pane {
                border-radius: 18px;
                border: 1px solid #E5E7EB;
                padding: 20px 22px;
                background: radial-gradient(circle at top left, #F0F9FF 0%, #FFFFFF 55%, #F8FAFC 100%);
                box-shadow: 0 14px 36px rgba(15,23,42,0.08);
            }

            .muted { color:#6b7280; font-size:0.86rem; }
        </style>
    `;

    specialsListEl = document.getElementById("specials-master-list");
    detailPaneEl   = document.getElementById("specials-detail-pane");
    addSpecialInput = document.getElementById("new-special-input");

    document.getElementById("add-special-btn").onclick = addSpecial;
    addSpecialInput.onkeyup = e => { if (e.key === "Enter") addSpecial(); };

    renderMasterLists();
    renderDetailPane();
}

/*********************************************************
 * LEFT LIST
 *********************************************************/
function renderMasterLists() {
    specialsListEl.innerHTML = "";
    if (specialActivities.length === 0) {
        specialsListEl.innerHTML = `<p class="muted">No special activities yet.</p>`;
    }
    specialActivities.forEach(item => {
        specialsListEl.appendChild(createMasterListItem('special', item));
    });
}

function createMasterListItem(type, item) {
    const el = document.createElement('div');
    el.className = 'list-item';

    const id = `${type}-${item.name}`;
    if (id === selectedItemId) el.classList.add('selected');

    el.onclick = () => {
        selectedItemId = id;
        renderMasterLists();
        renderDetailPane();
    };

    const nameEl = document.createElement('span');
    nameEl.className = 'list-item-name';
    nameEl.textContent = item.name;
    el.appendChild(nameEl);

    // switch
    const tog = document.createElement("label");
    tog.className = "switch list-item-toggle";
    tog.onclick = e => e.stopPropagation();

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.available;

    cb.onchange = e => {
        e.stopPropagation();
        item.available = cb.checked;
        window.saveGlobalSpecialActivities(specialActivities);
        renderDetailPane();
    };

    const slider = document.createElement("span");
    slider.className = "slider";

    tog.appendChild(cb);
    tog.appendChild(slider);
    el.appendChild(tog);

    return el;
}

/*********************************************************
 * DETAIL PANE
 *********************************************************/
function renderDetailPane() {
    if (!selectedItemId) {
        detailPaneEl.innerHTML = `<p class="muted">Select a special.</p>`;
        return;
    }

    const [type, name] = selectedItemId.split(/-(.+)/);
    const item = specialActivities.find(f => f.name === name);

    if (!item) {
        selectedItemId = null;
        detailPaneEl.innerHTML = `<p style="color:red;">Error.</p>`;
        return;
    }

    detailPaneEl.innerHTML = "";
    const onSave = () => window.saveGlobalSpecialActivities(specialActivities);
    const onRerender = () => renderDetailPane();

    // HEADER
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.borderBottom = '1px solid #E5E7EB';
    header.style.paddingBottom = '10px';
    header.style.marginBottom = '16px';

    const title = document.createElement('h3');
    title.style.margin = '0';
    title.style.fontSize = '1.05rem';
    title.style.fontWeight = '600';
    title.textContent = item.name;
    makeEditable(title, newName => {
        if (!newName.trim()) return;
        item.name = newName;
        selectedItemId = `special-${newName}`;
        onSave();
        renderMasterLists();
    });

    const del = document.createElement('button');
    del.textContent = "Delete";
    del.style.color = "#DC2626";
    del.style.border = "1px solid #FECACA";
    del.style.background = "#fff";
    del.style.borderRadius = "999px";
    del.onclick = () => {
        if (confirm(`Delete "${item.name}"?`)) {
            specialActivities = specialActivities.filter(s => s.name !== item.name);
            selectedItemId = null;
            onSave();
            renderMasterLists();
            renderDetailPane();
        }
    };

    header.appendChild(title);
    header.appendChild(del);
    detailPaneEl.appendChild(header);

    // AVAILABILITY STRIP
    const avail = document.createElement('div');
    avail.style.padding = "10px 14px";
    avail.style.borderRadius = "14px";
    avail.style.marginBottom = "18px";
    avail.style.border = "1px solid " + (item.available ? "#BBF7D0" : "#FECACA");
    avail.style.background = item.available ? "#ECFDF5" : "#FEF2F2";
    avail.innerHTML = `
        Currently <strong>${item.available ? 'AVAILABLE' : 'UNAVAILABLE'}</strong>.
        <span style="opacity:0.7;">(Toggle in the left list)</span>
    `;
    detailPaneEl.appendChild(avail);

    /*******************************************************
     * MAX USAGE CARD (FREQUENCY UPDATE)
     *******************************************************/
    const maxCard = document.createElement('div');
    Object.assign(maxCard.style, {
        background:"#ffffff",
        border:"1px solid #e5e7eb",
        borderRadius:"14px",
        padding:"16px 16px",
        marginBottom:"20px",
        boxShadow:"0 8px 18px rgba(15,23,42,0.06)"
    });

    const maxHdr = document.createElement('div');
    maxHdr.textContent = "Frequency Limits";
    maxHdr.style.fontWeight = "600";
    maxHdr.style.marginBottom = "6px";
    maxHdr.style.fontSize = "0.9rem";
    maxCard.appendChild(maxHdr);

    // If null/undefined -> "Add Limit"
    if (item.maxUsage === null || item.maxUsage === undefined) {
        const noLimitText = document.createElement('p');
        noLimitText.textContent = "Unlimited usage allowed.";
        noLimitText.style.margin = "0 0 10px";
        noLimitText.style.fontSize = "0.8rem";
        noLimitText.style.color = "#6b7280";
        maxCard.appendChild(noLimitText);

        const addLimitBtn = document.createElement("button");
        addLimitBtn.textContent = "+ Add Frequency Rule";
        addLimitBtn.style.background = "#00C896";
        addLimitBtn.style.color = "white";
        addLimitBtn.style.border = "none";
        addLimitBtn.style.fontSize = "0.8rem";
        
        addLimitBtn.onclick = () => {
            item.maxUsage = 1;      // Default count
            item.frequencyWeeks = 0; // Default (Lifetime/Summer)
            onSave();
            onRerender();
        };
        maxCard.appendChild(addLimitBtn);

    } else {
        const limitDesc = document.createElement('p');
        limitDesc.textContent = "Bunks are allowed to play this:";
        limitDesc.style.margin = "0 0 8px";
        limitDesc.style.fontSize = "0.8rem";
        limitDesc.style.color = "#6b7280";
        maxCard.appendChild(limitDesc);

        const controlRow = document.createElement("div");
        controlRow.style.display = "flex";
        controlRow.style.gap = "10px";
        controlRow.style.alignItems = "center";
        controlRow.style.flexWrap = "wrap";

        // 1. Count Input
        const maxInput = document.createElement("input");
        maxInput.type = "number";
        maxInput.style.width = "60px";
        maxInput.style.borderRadius = "999px";
        maxInput.style.border = "1px solid #D1D5DB";
        maxInput.style.padding = "6px 12px";
        maxInput.value = item.maxUsage;
        maxInput.min = 1;

        maxInput.oninput = () => {
            const val = maxInput.value.trim();
            if (val !== "") {
                item.maxUsage = Math.max(1, parseInt(val,10) || 1);
                onSave();
            }
        };

        const timeLabel = document.createElement("span");
        timeLabel.textContent = "time(s) per";
        timeLabel.style.fontSize = "0.85rem";

        // 2. Frequency Dropdown
        const freqSelect = document.createElement("select");
        freqSelect.style.borderRadius = "999px";
        freqSelect.style.padding = "6px 12px";
        freqSelect.style.border = "1px solid #D1D5DB";
        
        const opts = [
            {v: 0, t: "Summer (Lifetime)"},
            {v: 1, t: "1 Week (7 Days)"},
            {v: 2, t: "2 Weeks (14 Days)"},
            {v: 3, t: "3 Weeks (21 Days)"},
            {v: 4, t: "4 Weeks (28 Days)"}
        ];
        
        opts.forEach(o => {
            const op = document.createElement("option");
            op.value = o.v;
            op.textContent = o.t;
            if(item.frequencyWeeks === o.v) op.selected = true;
            freqSelect.appendChild(op);
        });

        freqSelect.onchange = () => {
            item.frequencyWeeks = parseInt(freqSelect.value, 10);
            onSave();
        };

        // 3. Remove Button
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove Rule";
        removeBtn.style.background = "#FEE2E2";
        removeBtn.style.color = "#DC2626";
        removeBtn.style.border = "1px solid #FECACA";
        
        removeBtn.onclick = () => {
            item.maxUsage = null;
            item.frequencyWeeks = 0;
            onSave();
            onRerender();
        };

        controlRow.appendChild(maxInput);
        controlRow.appendChild(timeLabel);
        controlRow.appendChild(freqSelect);
        controlRow.appendChild(removeBtn);
        maxCard.appendChild(controlRow);
    }

    detailPaneEl.appendChild(maxCard);

    /*******************************************************
     * SHARABLE RULES
     *******************************************************/
    const sharableControls = renderSharableControls(item, onSave, onRerender);
    sharableControls.style.borderTop = "1px solid #E5E7EB";
    sharableControls.style.marginTop = "16px";
    sharableControls.style.paddingTop = "14px";
    detailPaneEl.appendChild(sharableControls);

    /*******************************************************
     * ALLOWED DIV + BUNKS
     *******************************************************/
    detailPaneEl.appendChild(renderAllowedBunksControls(item, onSave, onRerender));

    /*******************************************************
     * TIME RULES
     *******************************************************/
    const times = renderTimeRulesUI(item, onSave, onRerender);
    times.style.marginTop = "14px";
    times.style.paddingTop = "14px";
    times.style.borderTop = "1px solid #E5E7EB";
    detailPaneEl.appendChild(times);
}

/*********************************************************
 * ADD SPECIAL
 *********************************************************/
function addSpecial() {
    const n = addSpecialInput.value.trim();
    if (!n) return;

    if (specialActivities.some(s => s.name.toLowerCase() === n.toLowerCase())) {
        alert("Special already exists.");
        return;
    }

    specialActivities.push({
        name: n,
        available: true,
        sharableWith: { type:'not_sharable', divisions:[] },
        limitUsage: { enabled:false, divisions:{} },
        timeRules: [],
        maxUsage: null,
        frequencyWeeks: 0
    });

    addSpecialInput.value = "";
    window.saveGlobalSpecialActivities(specialActivities);

    selectedItemId = `special-${n}`;
    renderMasterLists();
    renderDetailPane();
}

/*********************************************************
 * HELPERS, CHIP PICKERS, SWITCHES, RULE UI
 *********************************************************/
function parseTimeToMinutes(str) {
    if (!str || typeof str !== "string") return null;
    let s = str.trim().toLowerCase();
    let mer = null;
    if (s.endsWith("am")||s.endsWith("pm")) {
        mer = s.endsWith("am") ? "am":"pm";
        s = s.replace(/am|pm/g, "").trim();
    }
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1],10);
    const mm = parseInt(m[2],10);
    if (mer) {
        if (hh === 12) hh = (mer==="am"?0:12);
        else if (mer==="pm") hh += 12;
    }
    return hh*60 + mm;
}

function makeEditable(el, save) {
    el.ondblclick = e => {
        e.stopPropagation();
        const old = el.textContent;

        const input = document.createElement("input");
        input.type = "text";
        input.value = old;
        input.style.borderRadius = "999px";
        input.style.padding = "4px 10px";
        input.style.border = "1px solid #60A5FA";
        input.style.outline = "none";
        input.style.boxShadow = "0 0 0 1px rgba(96,165,250,0.4)";
        input.style.minWidth = "120px";

        el.replaceWith(input);
        input.focus();

        function done() {
            const val = input.value.trim();
            if (val && val !== old) save(val);
            el.textContent = val || old;
            input.replaceWith(el);
        }
        input.onblur = done;
        input.onkeyup = e => { if (e.key==="Enter") done(); };
    };
}

function renderTimeRulesUI(item, onSave, onRerender) {
    const wrap = document.createElement("div");
    wrap.style.paddingLeft = "14px";
    wrap.style.borderLeft = "3px solid #e5e7eb";

    wrap.innerHTML = `<strong>Global Time Rules:</strong>`;

    if (!item.timeRules) item.timeRules = [];

    const list = document.createElement("div");
    if (item.timeRules.length === 0)
        list.innerHTML = `<p class="muted" style="margin:0;">Available all day</p>`;

    item.timeRules.forEach((rule, idx) => {
        const row = document.createElement("div");
        Object.assign(row.style, {
            padding:"4px 6px",
            margin:"3px 0",
            background:"#f3f4f6",
            borderRadius:"8px",
        });

        row.innerHTML = `
            <strong style="color:${rule.type==="Available"?"#059669":"#DC2626"};">
                ${rule.type}
            </strong>
            from ${rule.start} to ${rule.end}
        `;

        const x = document.createElement("button");
        x.textContent = "✖";
        x.style.marginLeft = "10px";
        x.style.background = "transparent";
        x.style.border = "none";
        x.style.cursor = "pointer";
        x.onclick = () => {
            item.timeRules.splice(idx,1);
            onSave();
            onRerender();
        };

        row.appendChild(x);
        list.appendChild(row);
    });

    wrap.appendChild(list);

    // Add rule
    const form = document.createElement("div");
    form.style.marginTop = "10px";

    const sel = document.createElement("select");
    sel.style.borderRadius = "999px";
    sel.style.padding = "4px 10px";
    sel.innerHTML = `
        <option value="Available">Available</option>
        <option value="Unavailable">Unavailable</option>
    `;

    const s = document.createElement("input");
    s.placeholder = "9:00am";
    s.style.width = "90px";
    s.style.marginLeft = "6px";

    const txt = document.createElement("span");
    txt.textContent = " to ";
    txt.style.margin = "0 6px";

    const e = document.createElement("input");
    e.placeholder = "10:00am";
    e.style.width = "90px";

    const add = document.createElement("button");
    add.textContent = "Add";
    add.style.marginLeft = "8px";

    add.onclick = () => {
        if (!s.value || !e.value) return alert("Enter both times.");
        if (parseTimeToMinutes(s.value)==null ||
            parseTimeToMinutes(e.value)==null)
            return alert("Invalid time.");
        if (parseTimeToMinutes(s.value)>=parseTimeToMinutes(e.value))
            return alert("End must be after start.");

        item.timeRules.push({
            type: sel.value,
            start: s.value,
            end: e.value
        });
        onSave();
        onRerender();
    };

    form.appendChild(sel);
    form.appendChild(s);
    form.appendChild(txt);
    form.appendChild(e);
    form.appendChild(add);

    wrap.appendChild(form);
    return wrap;
}

/*********************************************************
 * SHARABLE UI
 *********************************************************/
function renderSharableControls(item, onSave, onRerender) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<strong>Sharing Rules:</strong>`;

    const rules = item.sharableWith || { type:'not_sharable', divisions:[] };
    const isSharable = rules.type !== 'not_sharable';

    const row = document.createElement("label");
    Object.assign(row.style,{
        display:"flex",
        alignItems:"center",
        gap:"10px",
        marginTop:"10px"
    });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isSharable;

    cb.onchange = () => {
        rules.type = cb.checked ? "all":"not_sharable";
        rules.divisions = [];
        onSave();
        onRerender();
    };

    const txt = document.createElement("span");
    txt.textContent = "Sharable";

    row.appendChild(cb);
    row.appendChild(txt);
    wrap.appendChild(row);

    // If sharable → show division chips
    if (isSharable) {
        const box = document.createElement("div");
        box.style.marginTop = "10px";
        box.style.paddingLeft = "20px";

        const help = document.createElement("div");
        help.textContent = "Limit to divisions (optional):";
        help.style.fontSize = "0.82rem";
        help.style.color = "#6b7280";
        help.style.marginBottom = "4px";
        box.appendChild(help);

        const chips = createChipPicker(
            window.availableDivisions || [],
            rules.divisions,
            () => {
                rules.type = rules.divisions.length ? "custom":"all";
                onSave();
                onRerender();
            }
        );

        box.appendChild(chips);
        wrap.appendChild(box);
    }

    return wrap;
}

function createChipPicker(all, selected, onToggle) {
    const box = document.createElement("div");
    box.style.display = "flex";
    box.style.flexWrap = "wrap";
    box.style.gap = "6px";

    all.forEach(name => {
        const chip = document.createElement("span");
        chip.textContent = name;
        chip.style.padding = "6px 12px";
        chip.style.borderRadius = "999px";
        chip.style.cursor = "pointer";
        chip.style.fontSize = "0.8rem";
        chip.style.border = "1px solid #d1d5db";

        const active = selected.includes(name);
        chip.style.background = active ? "#00C896" : "#f3f4f6";
        chip.style.color = active ? "#ffffff" : "#111827";

        chip.onclick = () => {
            const idx = selected.indexOf(name);
            if (idx>-1) selected.splice(idx,1);
            else selected.push(name);
            onToggle();
        };

        box.appendChild(chip);
    });

    return box;
}

/*********************************************************
 * ALLOWED DIVISION/BUNK RULES (Themed Perfectly)
 *********************************************************/
function renderAllowedBunksControls(item, onSave, onRerender) {
    const wrap = document.createElement("div");
    wrap.style.marginTop = "16px";
    wrap.style.paddingTop = "16px";
    wrap.style.borderTop = "1px solid #e5e7eb";

    wrap.innerHTML = `<strong>Allowed Divisions & Bunks:</strong>`;

    const rules = item.limitUsage || { enabled:false, divisions:{} };
    item.limitUsage = rules;

    // TOGGLE
    const mode = document.createElement("label");
    Object.assign(mode.style,{
        display:"flex",
        alignItems:"center",
        gap:"12px",
        marginTop:"10px",
        cursor:"pointer"
    });

    const tAll = document.createElement("span");
    tAll.textContent = "All Divisions";

    const track = document.createElement("span");
    Object.assign(track.style,{
        width:"44px",
        height:"24px",
        borderRadius:"999px",
        display:"inline-block",
        position:"relative",
        border:"1px solid #cbd5e1",
        background: rules.enabled ? "#d1d5db" : "#22c55e",
        transition:"0.2s"
    });

    const knob = document.createElement("span");
    Object.assign(knob.style,{
        width:"20px",
        height:"20px",
        borderRadius:"50%",
        background:"#ffffff",
        position:"absolute",
        top:"1px",
        left: rules.enabled ? "21px" : "1px",
        transition:"0.2s"
    });

    track.appendChild(knob);

    const tSpec = document.createElement("span");
    tSpec.textContent = "Specific Divisions/Bunks";

    mode.appendChild(tAll);
    mode.appendChild(track);
    mode.appendChild(tSpec);

    mode.onclick = () => {
        rules.enabled = !rules.enabled;
        onSave();
        onRerender();
    };

    wrap.appendChild(mode);

    // If NOT enabled → done
    if (!rules.enabled) return wrap;

    // PANEL
    const panel = document.createElement("div");
    panel.style.marginTop = "12px";
    panel.style.paddingLeft = "20px";
    panel.style.borderLeft = "3px solid #e5e7eb";

    const allDivs = window.availableDivisions || [];
    allDivs.forEach(div => {
        const divWrap = document.createElement("div");
        divWrap.style.marginTop = "8px";

        const isAllowed = div in rules.divisions;
        const bunks = window.divisions[div]?.bunks || [];
        const allowedBunks = rules.divisions[div] || [];

        const chip = createLimitChip(div, isAllowed, true);
        chip.onclick = () => {
            if (isAllowed) delete rules.divisions[div];
            else rules.divisions[div] = [];
            onSave();
            onRerender();
        };
        divWrap.appendChild(chip);

        // Show bunk chips
        if (isAllowed) {
            const bunkBox = document.createElement("div");
            bunkBox.style.display = "flex";
            bunkBox.style.flexWrap = "wrap";
            bunkBox.style.gap = "6px";
            bunkBox.style.marginTop = "6px";
            bunkBox.style.paddingLeft = "22px";

            if (allowedBunks.length > 0) {
                const allChip = createLimitChip("All " + div, false, false);
                allChip.style.borderColor = "#00C896";
                allChip.style.color = "#00C896";
                allChip.onclick = () => {
                    rules.divisions[div] = [];
                    onSave();
                    onRerender();
                };
                bunkBox.appendChild(allChip);
            }

            bunks.forEach(b => {
                const bc = createLimitChip(b, allowedBunks.includes(b), false);
                bc.onclick = () => {
                    const idx = allowedBunks.indexOf(b);
                    if (idx>-1) allowedBunks.splice(idx,1);
                    else allowedBunks.push(b);
                    onSave();
                    onRerender();
                };
                bunkBox.appendChild(bc);
            });

            divWrap.appendChild(bunkBox);
        }

        panel.appendChild(divWrap);
    });

    wrap.appendChild(panel);
    return wrap;
}

function createLimitChip(text, active) {
    const c = document.createElement("span");
    c.textContent = text;
    c.style.padding = "6px 12px";
    c.style.borderRadius = "999px";
    c.style.cursor = "pointer";
    c.style.fontSize = "0.8rem";
    c.style.border = "1px solid #D1D5DB";
    c.style.background = active ? "#00C896" : "#F3F4F6";
    c.style.color = active ? "#FFFFFF" : "#111827";
    return c;
}

window.initSpecialActivitiesTab = initSpecialActivitiesTab;

})();
