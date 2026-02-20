// ============================================================================
// fluid_config_ui.js — Fluid Scheduling Configuration Panel (v1.0)
// ============================================================================
//
// Adds a configuration UI for fluid scheduling mode.
// Users can:
//   - Toggle between Structured and Fluid mode
//   - Set per-division outcome requirements (X specials, Y sports)
//   - Define anchor windows (Lunch 12:00-1:00, Snack 2:30-3:00)
//   - Set day start/end times and default slot duration
//
// External visits are configured through Special Activities
// (mustScheduleWhenAvailable + availableDays)
//
// INTEGRATION: Call initFluidConfigPanel(containerEl) to render.
// Can be placed in daily_adjustments subtabs or as a standalone tab.
//
// LOAD ORDER: After fluid_scheduler.js
// ============================================================================

(function() {
    'use strict';

    let _container = null;
    let _config = null;

    // ========================================================================
    // HELPERS
    // ========================================================================

    function parseTimeToMinutes(str) {
        if (typeof str === 'number') return str;
        if (window.SchedulerCoreUtils?.parseTimeToMinutes) {
            return window.SchedulerCoreUtils.parseTimeToMinutes(str);
        }
        if (!str || typeof str !== 'string') return null;
        let s = str.trim().toLowerCase();
        let mer = null;
        if (s.endsWith('am') || s.endsWith('pm')) {
            mer = s.endsWith('am') ? 'am' : 'pm';
            s = s.replace(/am|pm/g, '').trim();
        }
        const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!m) return null;
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (mer) {
            if (hh === 12) hh = (mer === 'am') ? 0 : 12;
            else if (mer === 'pm') hh += 12;
        }
        return hh * 60 + mm;
    }

    function minutesToTime(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ap = h >= 12 ? 'pm' : 'am';
        return h12 + ':' + String(m).padStart(2, '0') + ap;
    }

    function minutesToInputValue(mins) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function inputValueToMinutes(val) {
        if (!val) return null;
        const [h, m] = val.split(':').map(Number);
        return h * 60 + m;
    }

    // ========================================================================
    // LOAD / SAVE
    // ========================================================================

    function loadConfig() {
        const settings = window.loadGlobalSettings?.() || {};
        return {
            scheduleMode: settings.scheduleMode || 'structured',
            fluidRequirements: settings.fluidRequirements || {}
        };
    }

    function saveConfig(config) {
        window.saveGlobalSettings?.('scheduleMode', config.scheduleMode);
        window.saveGlobalSettings?.('fluidRequirements', config.fluidRequirements);
        window.forceSyncToCloud?.();
    }

    function getDivisionNames() {
        const divisions = window.divisions || {};
        return Object.keys(divisions);
    }

    function getDefaultDivConfig() {
        return {
            dayStart: 540,
            dayEnd: 960,
            defaultSlotDuration: 30,
            requirements: [
                { type: 'special', count: 3, label: 'Special Activities' },
                { type: 'sport', count: 2, label: 'Sports' }
            ],
            anchors: [
                { name: 'Lunch', duration: 30, window: { earliest: 720, latest: 780 } },
                { name: 'Snack', duration: 15, window: { earliest: 870, latest: 915 } },
                { name: 'Dismissal', duration: 0, fixedAt: 960 }
            ],
            externalVisits: []
        };
    }

    // ========================================================================
    // MAIN RENDER
    // ========================================================================

    function initFluidConfigPanel(containerEl) {
        _container = containerEl;
        if (!_container) return;

        _config = loadConfig();
        render();
    }

    function render() {
        if (!_container) return;
        _config = loadConfig();

        const isFluid = _config.scheduleMode === 'fluid';
        const divNames = getDivisionNames();

        _container.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom:20px;';
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <span style="font-size:1.5rem;">🌊</span>
                <h3 style="margin:0; font-size:1.1rem; font-weight:700;">Scheduling Mode</h3>
            </div>
            <p style="margin:0; font-size:0.85rem; color:#6b7280;">
                <strong>Structured</strong> uses a fixed skeleton template. 
                <strong>Fluid</strong> builds each bunk's schedule from outcomes and activity durations.
            </p>
        `;
        _container.appendChild(header);

        // Mode Toggle
        const modeCard = document.createElement('div');
        modeCard.style.cssText = 'background:white; border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin-bottom:20px; box-shadow:0 1px 3px rgba(0,0,0,0.06);';
        
        const modeInner = document.createElement('div');
        modeInner.style.cssText = 'display:flex; gap:12px;';

        const structuredBtn = createModeButton('Structured', '📋', 'Fixed time slots defined in the skeleton. You decide when each activity type happens.', !isFluid);
        const fluidBtn = createModeButton('Fluid', '🌊', 'Define outcomes per bunk. The program figures out when everything happens based on activity durations.', isFluid);

        structuredBtn.onclick = () => {
            _config.scheduleMode = 'structured';
            saveConfig(_config);
            render();
        };
        fluidBtn.onclick = () => {
            _config.scheduleMode = 'fluid';
            saveConfig(_config);
            render();
        };

        modeInner.appendChild(structuredBtn);
        modeInner.appendChild(fluidBtn);
        modeCard.appendChild(modeInner);
        _container.appendChild(modeCard);

        // If structured, just show a note
        if (!isFluid) {
            const note = document.createElement('div');
            note.style.cssText = 'padding:20px; text-align:center; color:#9CA3AF; font-size:0.9rem;';
            note.textContent = 'Switch to Fluid mode to configure outcome-based scheduling.';
            _container.appendChild(note);
            return;
        }

        // Fluid config per division
        if (divNames.length === 0) {
            const noDivs = document.createElement('div');
            noDivs.style.cssText = 'padding:20px; text-align:center; color:#dc2626; font-size:0.9rem;';
            noDivs.textContent = 'No divisions found. Set up divisions in the Setup tab first.';
            _container.appendChild(noDivs);
            return;
        }

        divNames.forEach(divName => {
            _container.appendChild(renderDivisionConfig(divName));
        });
    }

    function createModeButton(label, icon, desc, isActive) {
        const btn = document.createElement('div');
        btn.style.cssText = `
            flex:1; padding:16px; border-radius:10px; cursor:pointer; transition:all 0.15s;
            border:2px solid ${isActive ? '#147D91' : '#e5e7eb'};
            background:${isActive ? '#e6f4f7' : '#fafafa'};
        `;
        btn.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:1.2rem;">${icon}</span>
                <span style="font-weight:700; font-size:0.95rem; color:${isActive ? '#0A4A56' : '#374151'};">${label}</span>
                ${isActive ? '<span style="font-size:0.7rem; background:#147D91; color:white; padding:2px 8px; border-radius:4px; font-weight:600;">ACTIVE</span>' : ''}
            </div>
            <div style="font-size:0.82rem; color:${isActive ? '#0F5F6E' : '#6b7280'};">${desc}</div>
        `;
        btn.onmouseenter = () => { if (!isActive) btn.style.borderColor = '#b2dce6'; };
        btn.onmouseleave = () => { if (!isActive) btn.style.borderColor = '#e5e7eb'; };
        return btn;
    }

    // ========================================================================
    // PER-DIVISION CONFIG
    // ========================================================================

    function renderDivisionConfig(divName) {
        const existing = _config.fluidRequirements[divName];
        const divConfig = existing || getDefaultDivConfig();

        // Ensure it's stored
        if (!existing) {
            _config.fluidRequirements[divName] = divConfig;
            saveConfig(_config);
        }

        const card = document.createElement('div');
        card.style.cssText = 'background:white; border:1px solid #e5e7eb; border-radius:12px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.06); overflow:hidden;';

        // Division header
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 16px; background:#f9fafb; border-bottom:1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center; cursor:pointer;';
        header.innerHTML = `
            <div>
                <span style="font-weight:700; font-size:0.95rem;">${divName}</span>
                <span style="font-size:0.8rem; color:#6b7280; margin-left:8px;">
                    ${divConfig.requirements.map(r => r.count + ' ' + r.type).join(', ')}
                </span>
            </div>
            <span class="div-caret" style="color:#9CA3AF; transition:transform 0.2s;">▸</span>
        `;

        const body = document.createElement('div');
        body.style.cssText = 'padding:16px; display:none;';

        header.onclick = () => {
            const open = body.style.display === 'block';
            body.style.display = open ? 'none' : 'block';
            header.querySelector('.div-caret').textContent = open ? '▸' : '▾';
        };

        // Day times
        body.appendChild(renderDayTimes(divName, divConfig));

        // Requirements
        body.appendChild(renderRequirements(divName, divConfig));

        // Anchors
        body.appendChild(renderAnchors(divName, divConfig));

        // External visits note
        const extNote = document.createElement('div');
        extNote.style.cssText = 'margin-top:14px; padding:10px 12px; background:#fef0e8; border:1px solid #f5c6a5; border-radius:8px; font-size:0.82rem; color:#c2571f;';
        extNote.innerHTML = '<strong>External Visits</strong> (like Bubble Guys) are configured in the <strong>Special Activities</strong> tab. Set "Must Schedule When Available" and pick the days they come.';
        body.appendChild(extNote);

        card.appendChild(header);
        card.appendChild(body);
        return card;
    }

    // ========================================================================
    // DAY TIMES
    // ========================================================================

    function renderDayTimes(divName, divConfig) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px;';
        section.innerHTML = `
            <div style="font-weight:600; font-size:0.85rem; margin-bottom:8px; color:#374151;">Day Times</div>
            <div style="display:flex; gap:12px; flex-wrap:wrap;">
                <div style="flex:1; min-width:120px;">
                    <label style="font-size:0.78rem; color:#6b7280; display:block; margin-bottom:4px;">Day Start</label>
                    <input type="time" class="fluid-day-start" value="${minutesToInputValue(divConfig.dayStart)}" 
                        style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.9rem;">
                </div>
                <div style="flex:1; min-width:120px;">
                    <label style="font-size:0.78rem; color:#6b7280; display:block; margin-bottom:4px;">Day End</label>
                    <input type="time" class="fluid-day-end" value="${minutesToInputValue(divConfig.dayEnd)}" 
                        style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.9rem;">
                </div>
                <div style="flex:1; min-width:120px;">
                    <label style="font-size:0.78rem; color:#6b7280; display:block; margin-bottom:4px;">Default Slot Duration</label>
                    <select class="fluid-default-dur" style="width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.9rem;">
                        <option value="20" ${divConfig.defaultSlotDuration === 20 ? 'selected' : ''}>20 min</option>
                        <option value="25" ${divConfig.defaultSlotDuration === 25 ? 'selected' : ''}>25 min</option>
                        <option value="30" ${divConfig.defaultSlotDuration === 30 ? 'selected' : ''}>30 min</option>
                        <option value="40" ${divConfig.defaultSlotDuration === 40 ? 'selected' : ''}>40 min</option>
                        <option value="45" ${divConfig.defaultSlotDuration === 45 ? 'selected' : ''}>45 min</option>
                    </select>
                </div>
            </div>
        `;

        section.querySelector('.fluid-day-start').onchange = function() {
            divConfig.dayStart = inputValueToMinutes(this.value) || 540;
            saveConfig(_config);
        };
        section.querySelector('.fluid-day-end').onchange = function() {
            divConfig.dayEnd = inputValueToMinutes(this.value) || 960;
            saveConfig(_config);
        };
        section.querySelector('.fluid-default-dur').onchange = function() {
            divConfig.defaultSlotDuration = parseInt(this.value) || 30;
            saveConfig(_config);
        };

        return section;
    }

    // ========================================================================
    // REQUIREMENTS
    // ========================================================================

    function renderRequirements(divName, divConfig) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px;';

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        headerRow.innerHTML = '<div style="font-weight:600; font-size:0.85rem; color:#374151;">Outcome Requirements</div>';

        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add';
        addBtn.style.cssText = 'padding:4px 10px; background:#147D91; color:white; border:none; border-radius:6px; font-size:0.78rem; cursor:pointer;';
        addBtn.onclick = () => {
            divConfig.requirements.push({ type: 'special', count: 1, label: 'Special Activities' });
            saveConfig(_config);
            section.replaceWith(renderRequirements(divName, divConfig));
        };
        headerRow.appendChild(addBtn);
        section.appendChild(headerRow);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:0.78rem; color:#9CA3AF; margin-bottom:8px;';
        hint.textContent = 'What each bunk must accomplish by end of day.';
        section.appendChild(hint);

        divConfig.requirements.forEach((req, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px; padding:8px 10px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px;';
            row.innerHTML = `
                <input type="number" min="1" max="20" value="${req.count}" style="width:50px; padding:6px; border:1px solid #d1d5db; border-radius:6px; text-align:center; font-size:0.9rem;" class="req-count">
                <select style="flex:1; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem;" class="req-type">
                    <option value="special" ${req.type === 'special' ? 'selected' : ''}>Special Activities</option>
                    <option value="sport" ${req.type === 'sport' ? 'selected' : ''}>Sports</option>
                    <option value="swim" ${req.type === 'swim' ? 'selected' : ''}>Swim</option>
                </select>
            `;

            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.style.cssText = 'padding:4px 8px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.8rem;';
            delBtn.onclick = () => {
                divConfig.requirements.splice(idx, 1);
                saveConfig(_config);
                section.replaceWith(renderRequirements(divName, divConfig));
            };
            row.appendChild(delBtn);

            row.querySelector('.req-count').onchange = function() {
                req.count = parseInt(this.value) || 1;
                saveConfig(_config);
            };
            row.querySelector('.req-type').onchange = function() {
                req.type = this.value;
                req.label = this.options[this.selectedIndex].text;
                saveConfig(_config);
            };

            section.appendChild(row);
        });

        return section;
    }

    // ========================================================================
    // ANCHORS
    // ========================================================================

    function renderAnchors(divName, divConfig) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:16px;';

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';
        headerRow.innerHTML = '<div style="font-weight:600; font-size:0.85rem; color:#374151;">Anchors (Fixed Events)</div>';

        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add';
        addBtn.style.cssText = 'padding:4px 10px; background:#147D91; color:white; border:none; border-radius:6px; font-size:0.78rem; cursor:pointer;';
        addBtn.onclick = () => {
            divConfig.anchors.push({ name: 'New Event', duration: 30, window: { earliest: 720, latest: 780 } });
            saveConfig(_config);
            section.replaceWith(renderAnchors(divName, divConfig));
        };
        headerRow.appendChild(addBtn);
        section.appendChild(headerRow);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:0.78rem; color:#9CA3AF; margin-bottom:8px;';
        hint.textContent = 'Events with a time window. The program places them within the window.';
        section.appendChild(hint);

        divConfig.anchors.forEach((anchor, idx) => {
            const isFixed = !!anchor.fixedAt;
            const row = document.createElement('div');
            row.style.cssText = 'padding:10px 12px; background:#f3eefa; border:1px solid #cdb8f0; border-radius:8px; margin-bottom:8px;';

            const topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px;';

            // Name
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = anchor.name || '';
            nameInput.placeholder = 'Event name';
            nameInput.style.cssText = 'flex:1; padding:6px 10px; border:1px solid #cdb8f0; border-radius:6px; font-size:0.9rem; font-weight:600;';
            nameInput.onchange = function() {
                anchor.name = this.value.trim() || 'Event';
                saveConfig(_config);
            };
            topRow.appendChild(nameInput);

            // Duration
            const durInput = document.createElement('input');
            durInput.type = 'number';
            durInput.min = '0';
            durInput.max = '120';
            durInput.step = '5';
            durInput.value = anchor.duration || 0;
            durInput.style.cssText = 'width:60px; padding:6px; border:1px solid #cdb8f0; border-radius:6px; text-align:center; font-size:0.9rem;';
            durInput.onchange = function() {
                anchor.duration = parseInt(this.value) || 0;
                saveConfig(_config);
            };
            const durLabel = document.createElement('span');
            durLabel.style.cssText = 'font-size:0.8rem; color:#6b7280;';
            durLabel.textContent = 'min';
            topRow.appendChild(durInput);
            topRow.appendChild(durLabel);

            // Delete
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.style.cssText = 'padding:4px 8px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.8rem;';
            delBtn.onclick = () => {
                divConfig.anchors.splice(idx, 1);
                saveConfig(_config);
                section.replaceWith(renderAnchors(divName, divConfig));
            };
            topRow.appendChild(delBtn);
            row.appendChild(topRow);

            // Time config — fixed or window
            const timeRow = document.createElement('div');
            timeRow.style.cssText = 'display:flex; gap:8px; align-items:center;';

            // Fixed toggle
            const fixedLabel = document.createElement('label');
            fixedLabel.style.cssText = 'display:flex; align-items:center; gap:4px; font-size:0.82rem; color:#6b7280; cursor:pointer;';
            fixedLabel.innerHTML = '<input type="checkbox" class="anchor-fixed-check" ' + (isFixed ? 'checked' : '') + '> Fixed time';
            timeRow.appendChild(fixedLabel);

            if (isFixed) {
                const fixedInput = document.createElement('input');
                fixedInput.type = 'time';
                fixedInput.value = minutesToInputValue(anchor.fixedAt);
                fixedInput.style.cssText = 'padding:6px 10px; border:1px solid #cdb8f0; border-radius:6px; font-size:0.9rem;';
                fixedInput.onchange = function() {
                    anchor.fixedAt = inputValueToMinutes(this.value);
                    delete anchor.window;
                    saveConfig(_config);
                };
                timeRow.appendChild(fixedInput);
            } else {
                const win = anchor.window || { earliest: 720, latest: 780 };

                const fromLabel = document.createElement('span');
                fromLabel.style.cssText = 'font-size:0.82rem; color:#6b7280;';
                fromLabel.textContent = 'Between';
                timeRow.appendChild(fromLabel);

                const fromInput = document.createElement('input');
                fromInput.type = 'time';
                fromInput.value = minutesToInputValue(win.earliest);
                fromInput.style.cssText = 'padding:6px 10px; border:1px solid #cdb8f0; border-radius:6px; font-size:0.9rem;';
                fromInput.onchange = function() {
                    if (!anchor.window) anchor.window = { earliest: 720, latest: 780 };
                    anchor.window.earliest = inputValueToMinutes(this.value);
                    delete anchor.fixedAt;
                    saveConfig(_config);
                };
                timeRow.appendChild(fromInput);

                const toLabel = document.createElement('span');
                toLabel.style.cssText = 'font-size:0.82rem; color:#6b7280;';
                toLabel.textContent = 'and';
                timeRow.appendChild(toLabel);

                const toInput = document.createElement('input');
                toInput.type = 'time';
                toInput.value = minutesToInputValue(win.latest);
                toInput.style.cssText = 'padding:6px 10px; border:1px solid #cdb8f0; border-radius:6px; font-size:0.9rem;';
                toInput.onchange = function() {
                    if (!anchor.window) anchor.window = { earliest: 720, latest: 780 };
                    anchor.window.latest = inputValueToMinutes(this.value);
                    delete anchor.fixedAt;
                    saveConfig(_config);
                };
                timeRow.appendChild(toInput);
            }

            // Handle fixed toggle
            fixedLabel.querySelector('.anchor-fixed-check').onchange = function() {
                if (this.checked) {
                    anchor.fixedAt = anchor.window?.earliest || 720;
                    delete anchor.window;
                } else {
                    anchor.window = { earliest: anchor.fixedAt || 720, latest: (anchor.fixedAt || 720) + 60 };
                    delete anchor.fixedAt;
                }
                saveConfig(_config);
                section.replaceWith(renderAnchors(divName, divConfig));
            };

            row.appendChild(timeRow);
            section.appendChild(row);
        });

        return section;
    }

    // ========================================================================
    // COPY CONFIG BETWEEN DIVISIONS
    // ========================================================================

    function copyConfigToDivision(fromDiv, toDiv) {
        if (!_config.fluidRequirements[fromDiv]) return;
        _config.fluidRequirements[toDiv] = JSON.parse(JSON.stringify(_config.fluidRequirements[fromDiv]));
        saveConfig(_config);
        render();
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.FluidConfigUI = {
        init: initFluidConfigPanel,
        render: render,
        copyConfigToDivision: copyConfigToDivision
    };

    window.initFluidConfigPanel = initFluidConfigPanel;

    console.log('🌊 Fluid Config UI loaded');

})();
