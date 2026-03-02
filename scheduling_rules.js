// ============================================================================
// scheduling_rules.js — CAMPISTRY SCHEDULING RULES TAB
// ============================================================================
// Renders the "Scheduling Rules" tab with expandable sections for all
// constraint types. Currently includes:
//   1. Activity Sequence Rules
//   2. Pinned Tile Location Cooldowns
//   3. Future rules placeholder (extensible)
//
// Data storage:
//   - Sequence rules → globalSettings.schedulingConstraints.sequenceRules
//   - Cooldowns → globalSettings.pinnedTileDefaults[name].cooldownSlots
//
// Runtime enforcement is handled by scheduling_constraints.js (separate file).
// This file is purely the UI/configuration layer.
// ============================================================================

(function() {
'use strict';

console.log('[SchedulingRules] Loading Scheduling Rules tab...');

let _isInitialized = false;

// =========================================================================
// DATA ACCESS
// =========================================================================

function loadSettings() {
    return window.loadGlobalSettings?.() || {};
}

function saveSettings(settings) {
    if (window.saveGlobalSettings) {
        window.saveGlobalSettings(settings);
    } else {
        localStorage.setItem('campistrySettings', JSON.stringify(settings));
    }
}

function getSequenceRules() {
    const settings = loadSettings();
    return settings.schedulingConstraints?.sequenceRules || [];
}

function saveSequenceRules(rules) {
    const settings = loadSettings();
    if (!settings.schedulingConstraints) settings.schedulingConstraints = {};
    settings.schedulingConstraints.sequenceRules = rules;
    saveSettings(settings);
}

function getPinnedTileDefaults() {
    const settings = loadSettings();
    return settings.pinnedTileDefaults || {};
}

function savePinnedTileDefaults(defaults) {
    const settings = loadSettings();
    settings.pinnedTileDefaults = defaults;
    saveSettings(settings);
}

function getAllActivityNames() {
    const settings = loadSettings();
    const app1 = settings.app1 || {};
    const names = new Set();

    (app1.fields || []).forEach(f => {
        if (f.name) names.add(f.name);
        (f.activities || []).forEach(a => names.add(a));
    });

    (app1.specialActivities || []).forEach(s => {
        if (s.name) names.add(s.name);
    });

    Object.keys(getPinnedTileDefaults()).forEach(k => names.add(k));

    return [...names].sort((a, b) => a.localeCompare(b));
}

// =========================================================================
// ESCAPE HELPER
// =========================================================================

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =========================================================================
// MAIN RENDER
// =========================================================================

function renderRulesTab(container) {
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom: 24px; padding: 0 4px;';
    header.innerHTML = `
        <h3 style="margin:0 0 6px 0; font-size:1.3rem; color:#0F172A; font-family:var(--font-display, Georgia, serif);">⚙️ Scheduling Rules</h3>
        <p style="margin:0; color:#64748B; font-size:0.9rem; line-height:1.5;">
            Configure constraints that the scheduler enforces during auto-generation and manual edits.
            Rules apply globally across all divisions.
        </p>
    `;
    container.appendChild(header);

    container.appendChild(renderSequenceRulesSection());
    container.appendChild(renderCooldownSection());
    container.appendChild(renderFuturePlaceholder());
}

// =========================================================================
// SECTION 1: SEQUENCE RULES
// =========================================================================

function renderSequenceRulesSection() {
    const section = createSection(
        '🔗 Activity Sequence Rules',
        'Prevent certain activities from being scheduled immediately before or after each other.',
        '#eff6ff', '#3b82f6'
    );

    const body = section.querySelector('.rules-section-body');
    const rules = getSequenceRules();

    // Existing rules list
    if (rules.length > 0) {
        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        rules.forEach((rule, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:white; border:1px solid #e5e7eb; border-radius:10px; flex-wrap:wrap;';

            const dirLabels = {
                'a_before_b': '→ cannot be right before →',
                'b_before_a': '← cannot be right after ←',
                'either': '↔ cannot be adjacent to ↔'
            };

            row.innerHTML = `
                <span style="font-weight:600; color:#1e40af; background:#dbeafe; padding:4px 10px; border-radius:6px; font-size:0.85rem;">${esc(rule.activityA)}</span>
                <span style="color:#64748b; font-size:0.8rem; flex-shrink:0;">${dirLabels[rule.direction] || rule.direction}</span>
                <span style="font-weight:600; color:#1e40af; background:#dbeafe; padding:4px 10px; border-radius:6px; font-size:0.85rem;">${esc(rule.activityB)}</span>
                <span style="flex:1;"></span>
            `;

            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.title = 'Remove this rule';
            delBtn.style.cssText = 'width:28px; height:28px; border-radius:6px; border:1px solid #fecaca; background:#fef2f2; color:#dc2626; cursor:pointer; font-size:0.9rem; font-weight:600; flex-shrink:0;';
            delBtn.onclick = () => {
                if (!confirm('Remove this sequence rule?')) return;
                const updated = getSequenceRules().filter((_, i) => i !== idx);
                saveSequenceRules(updated);
                renderRulesTab(document.getElementById('rules'));
            };
            row.appendChild(delBtn);
            list.appendChild(row);
        });

        body.appendChild(list);
    } else {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:#94a3b8; font-size:0.9rem; background:#f8fafc; border-radius:8px; margin-bottom:16px; border:1px dashed #cbd5e1;';
        empty.textContent = 'No sequence rules configured yet. Add one below.';
        body.appendChild(empty);
    }

    // Add new rule form
    const form = document.createElement('div');
    form.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:14px; background:#f0f9ff; border:1px solid #bfdbfe; border-radius:10px;';

    const activities = getAllActivityNames();
    const optionsHtml = '<option value="">-- Select Activity --</option>' +
        activities.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

    form.innerHTML = `
        <select id="seq-rule-a" style="padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.85rem; min-width:150px; background:white;">${optionsHtml}</select>
        <select id="seq-rule-dir" style="padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.85rem; background:white;">
            <option value="a_before_b">cannot be right before</option>
            <option value="b_before_a">cannot be right after</option>
            <option value="either">cannot be adjacent to</option>
        </select>
        <select id="seq-rule-b" style="padding:8px 10px; border:1px solid #d1d5db; border-radius:8px; font-size:0.85rem; min-width:150px; background:white;">${optionsHtml}</select>
    `;

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Rule';
    addBtn.style.cssText = 'padding:8px 18px; background:#2563eb; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:0.85rem; box-shadow:0 1px 3px rgba(37,99,235,0.3);';
    addBtn.onclick = () => {
        const a = document.getElementById('seq-rule-a').value;
        const b = document.getElementById('seq-rule-b').value;
        const dir = document.getElementById('seq-rule-dir').value;
        if (!a || !b) { alert('Please select both activities.'); return; }
        if (a === b) { alert('The two activities must be different.'); return; }
        const existing = getSequenceRules();
        const dup = existing.some(r =>
            (r.activityA === a && r.activityB === b && r.direction === dir) ||
            (r.activityA === b && r.activityB === a && r.direction === dir)
        );
        if (dup) { alert('This rule already exists.'); return; }
        existing.push({ activityA: a, activityB: b, direction: dir });
        saveSequenceRules(existing);
        renderRulesTab(document.getElementById('rules'));
    };
    form.appendChild(addBtn);
    body.appendChild(form);

    // Example hint
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:12px; padding:10px 14px; background:#eff6ff; border-radius:8px; font-size:0.8rem; color:#1e40af; line-height:1.5;';
    hint.innerHTML = '<strong>Example:</strong> If you add "Swim → cannot be right before → Art", ' +
        'the scheduler will never place Art in the slot immediately after Swim for any bunk. ' +
        'During manual edits, a warning dialog will appear with an option to override.';
    body.appendChild(hint);

    return section;
}

// =========================================================================
// SECTION 2: PINNED TILE COOLDOWNS
// =========================================================================

function renderCooldownSection() {
    const section = createSection(
        '❄️ Location Cooldowns',
        'After a pinned tile (Lunch, Snack, etc.) occupies a location, block that location for extra time slots.',
        '#fefce8', '#eab308'
    );

    const body = section.querySelector('.rules-section-body');
    const defaults = getPinnedTileDefaults();
    const entries = Object.entries(defaults);

    if (entries.length > 0) {
        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        entries.forEach(([tileName, val]) => {
            const location = typeof val === 'string' ? val : val?.location || '';
            const cooldown = typeof val === 'object' ? (val.cooldownSlots || 0) : 0;

            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:white; border:1px solid #e5e7eb; border-radius:10px; flex-wrap:wrap;';

            // Tile name + location
            const info = document.createElement('div');
            info.style.cssText = 'flex:1; min-width:160px;';
            info.innerHTML = `
                <div style="font-weight:600; color:#92400e;">${esc(tileName)}</div>
                <div style="font-size:0.8rem; color:#a16207; margin-top:2px;">📍 ${esc(location) || '<em style="color:#d1d5db;">No location set</em>'}</div>
            `;
            row.appendChild(info);

            // Cooldown input
            const coolWrap = document.createElement('div');
            coolWrap.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

            const coolLabel = document.createElement('span');
            coolLabel.style.cssText = 'font-size:0.8rem; color:#6b7280;';
            coolLabel.textContent = 'Cooldown:';
            coolWrap.appendChild(coolLabel);

            const coolInput = document.createElement('input');
            coolInput.type = 'number';
            coolInput.min = '0';
            coolInput.max = '5';
            coolInput.value = cooldown;
            coolInput.style.cssText = 'width:50px; padding:6px 8px; border:1px solid #fde68a; border-radius:6px; text-align:center; font-size:0.85rem; background:#fffbeb;';
            coolInput.className = 'pinned-cooldown-input';
            coolInput.onchange = () => {
                const v = Math.min(5, Math.max(0, parseInt(coolInput.value) || 0));
                coolInput.value = v;
                const updated = getPinnedTileDefaults();
                if (typeof updated[tileName] === 'string') {
                    updated[tileName] = { location: updated[tileName], cooldownSlots: v };
                } else {
                    updated[tileName] = { ...(updated[tileName] || {}), cooldownSlots: v };
                }
                savePinnedTileDefaults(updated);
                // Visual feedback
                coolInput.style.borderColor = '#22c55e';
                setTimeout(() => { coolInput.style.borderColor = '#fde68a'; }, 800);
            };
            coolWrap.appendChild(coolInput);

            const slotsLabel = document.createElement('span');
            slotsLabel.style.cssText = 'font-size:0.8rem; color:#6b7280;';
            slotsLabel.textContent = 'slot(s) after';
            coolWrap.appendChild(slotsLabel);

            row.appendChild(coolWrap);
            list.appendChild(row);
        });

        body.appendChild(list);
    } else {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:#94a3b8; font-size:0.9rem; background:#f8fafc; border-radius:8px; margin-bottom:16px; border:1px dashed #cbd5e1;';
        empty.innerHTML = 'No pinned tile defaults configured.<br><span style="font-size:0.8rem;">Set them up in the <strong>Locations</strong> tab → Pinned Tile Defaults section.</span>';
        body.appendChild(empty);
    }

    // Info box
    const info = document.createElement('div');
    info.style.cssText = 'margin-top:12px; padding:10px 14px; background:#fefce8; border:1px solid #fde68a; border-radius:8px; font-size:0.8rem; color:#92400e; line-height:1.5;';
    info.innerHTML = '<strong>How it works:</strong> If "Lunch" occupies "Gym" with cooldown = 1, ' +
        'the scheduler won\'t place any activity in the Gym for 1 additional slot after Lunch. ' +
        'This is enforced in both auto-generate and manual edits. Set to 0 for no cooldown.';
    body.appendChild(info);

    return section;
}

// =========================================================================
// SECTION 3: FUTURE PLACEHOLDER
// =========================================================================

function renderFuturePlaceholder() {
    const section = createSection(
        '🔮 More Rules Coming Soon',
        'Additional scheduling constraints will be added here as the platform evolves.',
        '#f5f3ff', '#8b5cf6'
    );

    const body = section.querySelector('.rules-section-body');

    const ideas = [
        { icon: '🏊', label: 'Sport-Specific Rules', desc: 'e.g., "No swimming within 30 min of eating"' },
        { icon: '⏰', label: 'Minimum Gap Rules', desc: 'e.g., "At least 2 slots between high-energy activities"' },
        { icon: '🔄', label: 'Rotation Overrides', desc: 'e.g., "Bunk 3A must do Art at least twice per week"' },
        { icon: '🌧️', label: 'Weather Transition Rules', desc: 'e.g., "When switching to rainy day, preserve pinned tiles"' }
    ];

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:10px;';

    ideas.forEach(idea => {
        const card = document.createElement('div');
        card.style.cssText = 'padding:14px; background:white; border:1px dashed #d8b4fe; border-radius:10px; opacity:0.6;';
        card.innerHTML = `
            <div style="font-weight:500; color:#6b21a8; margin-bottom:4px;">${idea.icon} ${esc(idea.label)}</div>
            <div style="font-size:0.8rem; color:#7c3aed;">${esc(idea.desc)}</div>
        `;
        grid.appendChild(card);
    });

    body.appendChild(grid);
    return section;
}

// =========================================================================
// SECTION BUILDER HELPER
// =========================================================================

function createSection(title, description, bgColor, accentColor) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rules-section';
    wrapper.style.cssText = 'margin-bottom:20px; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.04);';

    const header = document.createElement('div');
    header.style.cssText = `padding:16px 20px; background:${bgColor}; border-bottom:1px solid #e5e7eb; cursor:pointer; display:flex; align-items:center; justify-content:space-between; user-select:none;`;

    header.innerHTML = `
        <div style="flex:1;">
            <div style="font-weight:600; font-size:1rem; color:#1f2937;">${title}</div>
            <div style="font-size:0.8rem; color:#6b7280; margin-top:4px; line-height:1.4;">${description}</div>
        </div>
        <span class="rules-chevron" style="font-size:1.2rem; color:${accentColor}; transition:transform 0.2s; margin-left:12px; flex-shrink:0;">▼</span>
    `;

    const body = document.createElement('div');
    body.className = 'rules-section-body';
    body.style.cssText = 'padding:16px 20px; background:white;';

    header.onclick = () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        header.querySelector('.rules-chevron').style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
    };

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
}

// =========================================================================
// INIT
// =========================================================================

function initRulesTab() {
    const container = document.getElementById('rules');
    if (!container) {
        console.warn('[SchedulingRules] #rules container not found');
        return;
    }

    renderRulesTab(container);
    _isInitialized = true;
    console.log('[SchedulingRules] ✅ Rules tab initialized');
}

// =========================================================================
// EXPORTS
// =========================================================================

window.initRulesTab = initRulesTab;

console.log('[SchedulingRules] Module loaded');

})();
