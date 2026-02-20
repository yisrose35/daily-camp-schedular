// ============================================================================
// auto_mode_config.js — Auto Scheduling Mode Configuration (v1.0)
// ============================================================================
//
// Provides the UI for switching between Manual (skeleton) and Auto mode,
// and configuring the auto builder requirements.
//
// AUTO MODE means:
//   - No skeleton needed. The program builds each bunk's schedule.
//   - Camp defines outcomes: "3 specials, 2 sports per bunk"
//   - Camp defines anchors with time windows: "Lunch between 12-1"
//   - Activity durations come from Special Activities settings
//   - External visits (mustScheduleWhenAvailable) come from Special Activities
//   - Division start/end times come from Setup tab (already configured)
//
// WHERE IT LIVES:
//   - Mode toggle: Setup tab (camp-level decision)
//   - Auto config: Daily Adjustments tab (replaces skeleton when Auto is on)
//
// ============================================================================

(function() {
    'use strict';

    // ========================================================================
    // HELPERS
    // ========================================================================

    function minutesToInputValue(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function inputValueToMinutes(val) {
        if (!val) return null;
        const [h, m] = val.split(':').map(Number);
        return h * 60 + m;
    }

    function minutesToTime(mins) {
        if (mins === null || mins === undefined) return '';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ap = h >= 12 ? 'pm' : 'am';
        return h12 + ':' + String(m).padStart(2, '0') + ap;
    }

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
        const match = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
        if (!match) return null;
        let hh = parseInt(match[1], 10);
        const mm = parseInt(match[2], 10);
        if (mer) {
            if (hh === 12) hh = (mer === 'am') ? 0 : 12;
            else if (mer === 'pm') hh += 12;
        }
        return hh * 60 + mm;
    }

    // ========================================================================
    // LOAD / SAVE
    // ========================================================================

    function isAutoMode() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.scheduleMode === 'auto';
    }

    function setAutoMode(enabled) {
        window.saveGlobalSettings?.('scheduleMode', enabled ? 'auto' : 'structured');
        window.forceSyncToCloud?.();
    }

    function loadAutoConfig() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.autoRequirements || {};
    }

    function saveAutoConfig(config) {
        window.saveGlobalSettings?.('autoRequirements', config);
        window.forceSyncToCloud?.();
    }

    function getDivisions() {
        const settings = window.loadGlobalSettings?.() || {};
        return settings.divisions || window.divisions || {};
    }

    function getDivisionTimes(divName) {
        const divisions = getDivisions();
        const div = divisions[divName];
        if (!div) return { start: 540, end: 960 };
        return {
            start: parseTimeToMinutes(div.startTime) || 540,
            end: parseTimeToMinutes(div.endTime) || 960
        };
    }

    function getDefaultConfig() {
        return {
            requirements: [
                { type: 'special', count: 3 },
                { type: 'sport', count: 2 }
            ],
            anchors: [
                { name: 'Lunch', duration: 30, window: { earliest: 720, latest: 780 } },
                { name: 'Snack', duration: 15, window: { earliest: 870, latest: 915 } }
            ]
        };
    }

    // ========================================================================
    // MODE TOGGLE — For the Setup tab
    // ========================================================================

    function renderModeToggle(containerEl) {
        if (!containerEl) return;

        const active = isAutoMode();

        containerEl.innerHTML = `
            <div style="background:white; border:1px solid #e5e7eb; border-radius:12px; padding:16px; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                    <span style="font-size:1.3rem;">⚡</span>
                    <div>
                        <div style="font-weight:700; font-size:0.95rem;">Scheduling Mode</div>
                        <div style="font-size:0.8rem; color:#6b7280;">How should the program build daily schedules?</div>
                    </div>
                </div>
                <div style="display:flex; gap:10px;" id="mode-toggle-buttons"></div>
            </div>
        `;

        const btnContainer = containerEl.querySelector('#mode-toggle-buttons');

        const manualBtn = makeModeBtn(
            'Manual', '📋',
            'You build the skeleton. The program fills in activities.',
            !active
        );
        const autoBtn = makeModeBtn(
            'Auto', '⚡',
            'You define outcomes. The program builds each bunk\'s entire day.',
            active
        );

        manualBtn.onclick = () => { setAutoMode(false); renderModeToggle(containerEl); window.initDailyAdjustments?.(); };
        autoBtn.onclick = () => { setAutoMode(true); renderModeToggle(containerEl); window.initDailyAdjustments?.(); };

        btnContainer.appendChild(manualBtn);
        btnContainer.appendChild(autoBtn);
    }

    function makeModeBtn(label, icon, desc, active) {
        const btn = document.createElement('div');
        btn.style.cssText = `flex:1; padding:14px; border-radius:10px; cursor:pointer; transition:all 0.15s;
            border:2px solid ${active ? '#147D91' : '#e5e7eb'};
            background:${active ? '#e6f4f7' : '#fafafa'};`;
        btn.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                <span style="font-size:1.1rem;">${icon}</span>
                <span style="font-weight:700; font-size:0.9rem; color:${active ? '#0A4A56' : '#374151'};">${label}</span>
                ${active ? '<span style="font-size:0.65rem; background:#147D91; color:white; padding:2px 7px; border-radius:4px; font-weight:600;">ACTIVE</span>' : ''}
            </div>
            <div style="font-size:0.8rem; color:${active ? '#0F5F6E' : '#6b7280'}; line-height:1.4;">${desc}</div>
        `;
        btn.onmouseenter = () => { if (!active) btn.style.borderColor = '#b2dce6'; };
        btn.onmouseleave = () => { if (!active) btn.style.borderColor = '#e5e7eb'; };
        return btn;
    }

    // ========================================================================
    // AUTO BUILDER PANEL — Replaces skeleton in Daily Adjustments
    // ========================================================================

    function renderAutoBuilder(containerEl) {
        if (!containerEl) return;

        const config = loadAutoConfig();
        const divisions = getDivisions();
        const divNames = Object.keys(divisions);

        containerEl.innerHTML = '';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom:20px;';
        header.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:1.4rem;">⚡</span>
                    <div>
                        <h3 style="margin:0; font-size:1.1rem; font-weight:700;">Auto Builder</h3>
                        <div style="font-size:0.82rem; color:#6b7280;">Define what each bunk needs. The program handles the rest.</div>
                    </div>
                </div>
                <button id="auto-generate-btn" style="background:#147D91; color:white; border:none; padding:10px 24px; border-radius:8px; font-size:0.9rem; font-weight:600; cursor:pointer; box-shadow:0 2px 8px rgba(20,125,145,0.3);">
                    Generate Schedules
                </button>
            </div>
        `;
        containerEl.appendChild(header);

        // Generate button
        containerEl.querySelector('#auto-generate-btn').onclick = () => {
            if (window.FluidScheduler?.runFluidScheduler) {
                const btn = containerEl.querySelector('#auto-generate-btn');
                btn.textContent = 'Generating...';
                btn.disabled = true;
                setTimeout(() => {
                    const success = window.FluidScheduler.runFluidScheduler();
                    if (success) {
                        btn.textContent = '✓ Done!';
                        btn.style.background = '#2d8a4e';
                        window.updateTable?.();
                        setTimeout(() => {
                            btn.textContent = 'Generate Schedules';
                            btn.style.background = '#147D91';
                            btn.disabled = false;
                        }, 2000);
                    } else {
                        btn.textContent = 'Failed — try again';
                        btn.style.background = '#dc2626';
                        btn.disabled = false;
                        setTimeout(() => {
                            btn.textContent = 'Generate Schedules';
                            btn.style.background = '#147D91';
                        }, 2000);
                    }
                }, 50);
            }
        };

        if (divNames.length === 0) {
            const msg = document.createElement('div');
            msg.style.cssText = 'padding:30px; text-align:center; color:#9CA3AF;';
            msg.textContent = 'Set up your divisions in the Setup tab first.';
            containerEl.appendChild(msg);
            return;
        }

        // Per-division cards
        divNames.forEach(divName => {
            containerEl.appendChild(renderDivCard(divName, config, divisions));
        });
    }

    // ========================================================================
    // DIVISION CARD
    // ========================================================================

    function renderDivCard(divName, config, divisions) {
        const divConfig = config[divName] || getDefaultConfig();
        const times = getDivisionTimes(divName);
        const bunks = divisions[divName]?.bunks || [];

        // Auto-save if this division didn't have config yet
        if (!config[divName]) {
            config[divName] = divConfig;
            saveAutoConfig(config);
        }

        const card = document.createElement('div');
        card.style.cssText = 'background:white; border:1px solid #e5e7eb; border-radius:12px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06); overflow:hidden;';

        // Header — always visible
        const header = document.createElement('div');
        header.style.cssText = 'padding:12px 16px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none;';
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-weight:700; font-size:0.95rem;">${divName}</span>
                <span style="font-size:0.78rem; color:#6b7280; background:#f3f4f6; padding:2px 8px; border-radius:4px;">
                    ${bunks.length} bunks · ${minutesToTime(times.start)}-${minutesToTime(times.end)}
                </span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:0.78rem; color:#9CA3AF;">
                    ${divConfig.requirements.map(r => r.count + ' ' + r.type + (r.count > 1 ? 's' : '')).join(', ')}
                </span>
                <span class="dc-caret" style="color:#9CA3AF; font-size:0.8rem;">▸</span>
            </div>
        `;

        // Body — collapsible
        const body = document.createElement('div');
        body.style.cssText = 'padding:0 16px 16px; display:none; border-top:1px solid #f0efec;';

        header.onclick = () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            header.querySelector('.dc-caret').textContent = open ? '▸' : '▾';
        };

        // Requirements section
        body.appendChild(renderRequirements(divName, divConfig, config));

        // Anchors section
        body.appendChild(renderAnchors(divName, divConfig, config));

        // Info note about external visits
        const note = document.createElement('div');
        note.style.cssText = 'margin-top:12px; padding:10px; background:#f0f9fb; border:1px solid #b2dce6; border-radius:8px; font-size:0.8rem; color:#0F5F6E; line-height:1.5;';
        note.innerHTML = '💡 <strong>External visitors</strong> (like Bubble Guys) are set up in Special Activities → Fluid Scheduling. Set their duration, days, and turn on "Must Schedule When Available."';
        body.appendChild(note);

        card.appendChild(header);
        card.appendChild(body);
        return card;
    }

    // ========================================================================
    // REQUIREMENTS
    // ========================================================================

    function renderRequirements(divName, divConfig, fullConfig) {
        const section = document.createElement('div');
        section.style.cssText = 'padding-top:14px; margin-bottom:14px;';

        const label = document.createElement('div');
        label.style.cssText = 'font-weight:600; font-size:0.85rem; color:#374151; margin-bottom:6px;';
        label.textContent = 'Each bunk needs:';
        section.appendChild(label);

        const list = document.createElement('div');

        divConfig.requirements.forEach((req, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px;';

            // Count
            const countInput = document.createElement('input');
            countInput.type = 'number';
            countInput.min = '1';
            countInput.max = '15';
            countInput.value = req.count;
            countInput.style.cssText = 'width:48px; padding:6px; border:1px solid #d1d5db; border-radius:6px; text-align:center; font-size:0.9rem;';
            countInput.onchange = function() {
                req.count = parseInt(this.value) || 1;
                saveAutoConfig(fullConfig);
            };

            // Type
            const typeSelect = document.createElement('select');
            typeSelect.style.cssText = 'flex:1; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem;';
            typeSelect.innerHTML = `
                <option value="special" ${req.type === 'special' ? 'selected' : ''}>Special Activities</option>
                <option value="sport" ${req.type === 'sport' ? 'selected' : ''}>Sports</option>
                <option value="swim" ${req.type === 'swim' ? 'selected' : ''}>Swim</option>
            `;
            typeSelect.onchange = function() {
                req.type = this.value;
                saveAutoConfig(fullConfig);
            };

            // Delete
            const del = document.createElement('button');
            del.textContent = '✕';
            del.style.cssText = 'width:28px; height:28px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.75rem; display:flex; align-items:center; justify-content:center;';
            del.onclick = () => {
                divConfig.requirements.splice(idx, 1);
                saveAutoConfig(fullConfig);
                section.replaceWith(renderRequirements(divName, divConfig, fullConfig));
            };

            row.appendChild(countInput);
            row.appendChild(typeSelect);
            row.appendChild(del);
            list.appendChild(row);
        });

        section.appendChild(list);

        // Add button
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add requirement';
        addBtn.style.cssText = 'padding:5px 12px; background:white; color:#147D91; border:1px solid #b2dce6; border-radius:6px; font-size:0.8rem; cursor:pointer; margin-top:4px;';
        addBtn.onclick = () => {
            divConfig.requirements.push({ type: 'special', count: 1 });
            saveAutoConfig(fullConfig);
            section.replaceWith(renderRequirements(divName, divConfig, fullConfig));
        };
        section.appendChild(addBtn);

        return section;
    }

    // ========================================================================
    // ANCHORS
    // ========================================================================

    function renderAnchors(divName, divConfig, fullConfig) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:10px;';

        const label = document.createElement('div');
        label.style.cssText = 'font-weight:600; font-size:0.85rem; color:#374151; margin-bottom:6px;';
        label.textContent = 'Fixed events:';
        section.appendChild(label);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:0.78rem; color:#9CA3AF; margin-bottom:8px;';
        hint.textContent = 'Set a time window and the program places them where they fit best.';
        section.appendChild(hint);

        const list = document.createElement('div');

        divConfig.anchors.forEach((anchor, idx) => {
            const isFixed = !!anchor.fixedAt;
            const win = anchor.window || { earliest: 720, latest: 780 };

            const row = document.createElement('div');
            row.style.cssText = 'padding:10px; background:#f9f8f6; border:1px solid #e5e3de; border-radius:8px; margin-bottom:8px;';

            // Top: name + duration + delete
            const top = document.createElement('div');
            top.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px;';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = anchor.name || '';
            nameInput.placeholder = 'Event name';
            nameInput.style.cssText = 'flex:1; padding:5px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.88rem; font-weight:600;';
            nameInput.onchange = function() { anchor.name = this.value.trim() || 'Event'; saveAutoConfig(fullConfig); };

            const durWrap = document.createElement('div');
            durWrap.style.cssText = 'display:flex; align-items:center; gap:4px;';
            const durInput = document.createElement('input');
            durInput.type = 'number';
            durInput.min = '0';
            durInput.max = '120';
            durInput.step = '5';
            durInput.value = anchor.duration || 0;
            durInput.style.cssText = 'width:48px; padding:5px; border:1px solid #d1d5db; border-radius:6px; text-align:center; font-size:0.88rem;';
            durInput.onchange = function() { anchor.duration = parseInt(this.value) || 0; saveAutoConfig(fullConfig); };
            const durLabel = document.createElement('span');
            durLabel.style.cssText = 'font-size:0.78rem; color:#6b7280;';
            durLabel.textContent = 'min';
            durWrap.appendChild(durInput);
            durWrap.appendChild(durLabel);

            const del = document.createElement('button');
            del.textContent = '✕';
            del.style.cssText = 'width:28px; height:28px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.75rem; display:flex; align-items:center; justify-content:center;';
            del.onclick = () => {
                divConfig.anchors.splice(idx, 1);
                saveAutoConfig(fullConfig);
                section.replaceWith(renderAnchors(divName, divConfig, fullConfig));
            };

            top.appendChild(nameInput);
            top.appendChild(durWrap);
            top.appendChild(del);
            row.appendChild(top);

            // Bottom: time window
            const bottom = document.createElement('div');
            bottom.style.cssText = 'display:flex; gap:6px; align-items:center; font-size:0.85rem;';

            if (isFixed) {
                bottom.innerHTML = '<span style="color:#6b7280;">Fixed at</span>';
                const tInput = document.createElement('input');
                tInput.type = 'time';
                tInput.value = minutesToInputValue(anchor.fixedAt);
                tInput.style.cssText = 'padding:5px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;';
                tInput.onchange = function() { anchor.fixedAt = inputValueToMinutes(this.value); delete anchor.window; saveAutoConfig(fullConfig); };
                bottom.appendChild(tInput);
            } else {
                bottom.innerHTML = '<span style="color:#6b7280;">Anytime between</span>';
                const fromInput = document.createElement('input');
                fromInput.type = 'time';
                fromInput.value = minutesToInputValue(win.earliest);
                fromInput.style.cssText = 'padding:5px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;';
                fromInput.onchange = function() {
                    if (!anchor.window) anchor.window = { earliest: 720, latest: 780 };
                    anchor.window.earliest = inputValueToMinutes(this.value);
                    delete anchor.fixedAt;
                    saveAutoConfig(fullConfig);
                };
                bottom.appendChild(fromInput);

                const andSpan = document.createElement('span');
                andSpan.style.cssText = 'color:#6b7280;';
                andSpan.textContent = 'and';
                bottom.appendChild(andSpan);

                const toInput = document.createElement('input');
                toInput.type = 'time';
                toInput.value = minutesToInputValue(win.latest);
                toInput.style.cssText = 'padding:5px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;';
                toInput.onchange = function() {
                    if (!anchor.window) anchor.window = { earliest: 720, latest: 780 };
                    anchor.window.latest = inputValueToMinutes(this.value);
                    delete anchor.fixedAt;
                    saveAutoConfig(fullConfig);
                };
                bottom.appendChild(toInput);
            }

            // Fixed/Window toggle
            const toggleLabel = document.createElement('label');
            toggleLabel.style.cssText = 'display:flex; align-items:center; gap:4px; margin-left:auto; font-size:0.78rem; color:#9CA3AF; cursor:pointer;';
            toggleLabel.innerHTML = `<input type="checkbox" ${isFixed ? 'checked' : ''}> exact time`;
            toggleLabel.querySelector('input').onchange = function() {
                if (this.checked) {
                    anchor.fixedAt = anchor.window?.earliest || 720;
                    delete anchor.window;
                } else {
                    anchor.window = { earliest: anchor.fixedAt || 720, latest: (anchor.fixedAt || 720) + 60 };
                    delete anchor.fixedAt;
                }
                saveAutoConfig(fullConfig);
                section.replaceWith(renderAnchors(divName, divConfig, fullConfig));
            };
            bottom.appendChild(toggleLabel);

            row.appendChild(bottom);
            list.appendChild(row);
        });

        section.appendChild(list);

        // Add button
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add event';
        addBtn.style.cssText = 'padding:5px 12px; background:white; color:#147D91; border:1px solid #b2dce6; border-radius:6px; font-size:0.8rem; cursor:pointer; margin-top:4px;';
        addBtn.onclick = () => {
            divConfig.anchors.push({ name: '', duration: 30, window: { earliest: 720, latest: 780 } });
            saveAutoConfig(fullConfig);
            section.replaceWith(renderAnchors(divName, divConfig, fullConfig));
        };
        section.appendChild(addBtn);

        return section;
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.AutoModeConfig = {
        isAutoMode,
        setAutoMode,
        renderModeToggle,
        renderAutoBuilder,
        loadAutoConfig,
        saveAutoConfig
    };

    // Convenience globals
    window.isAutoMode = isAutoMode;
    window.renderAutoModeToggle = renderModeToggle;
    window.renderAutoBuilder = renderAutoBuilder;

    console.log('⚡ Auto Mode Config loaded');

})();
