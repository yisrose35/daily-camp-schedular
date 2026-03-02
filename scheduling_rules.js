// ============================================================================
// scheduling_rules.js — CAMPISTRY RULES TAB (v2.0)
// ============================================================================
// Renders the "Rules" tab with expandable sections for all constraint types.
// Sections:
//   1. Activity Sequence Rules
//   2. Pinned Tile Location Cooldowns
//   3. Sports Rules (min/max players — moved from fields.js)
//
// Data storage:
//   - Sequence rules → globalSettings.schedulingConstraints.sequenceRules
//   - Cooldowns → globalSettings.pinnedTileDefaults[name].cooldownSlots
//   - Sport meta → globalSettings.app1.sportMetaData
//
// Runtime enforcement: scheduling_constraints.js (separate file).
// This file is purely the UI/configuration layer.
// ============================================================================

(function() {
'use strict';

console.log('[SchedulingRules] Loading Rules tab...');

let _isInitialized = false;

// =========================================================================
// DATA ACCESS
// =========================================================================

function loadSettings() {
    return window.loadGlobalSettings?.() || {};
}

function saveSettings(key, value) {
    if (window.saveGlobalSettings) {
        window.saveGlobalSettings(key, value);
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
    saveSettings('schedulingConstraints', settings.schedulingConstraints);
}

function getPinnedTileDefaults() {
    const settings = loadSettings();
    return settings.pinnedTileDefaults || {};
}

function savePinnedTileDefaults(defaults) {
    saveSettings('pinnedTileDefaults', defaults);
}

function getSportMetaData() {
    const settings = loadSettings();
    return settings.app1?.sportMetaData || {};
}

function saveSportMetaData(meta) {
    const settings = loadSettings();
    if (!settings.app1) settings.app1 = {};
    settings.app1.sportMetaData = meta;
    saveSettings('app1', settings.app1);
    if (typeof window.requestCloudSync === 'function') {
        window.requestCloudSync();
    }
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

function getAllSportsFromFields() {
    if (window.getAllGlobalSports) {
        return window.getAllGlobalSports();
    }
    const settings = loadSettings();
    const fields = settings.app1?.fields || [];
    const sports = new Set();
    fields.forEach(f => {
        (f.activities || []).forEach(a => sports.add(a));
    });
    return [...sports].sort();
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

    // Wrapper matching setup-grid pattern
    var wrapper = document.createElement('div');
    wrapper.className = 'setup-grid';

    var card = document.createElement('section');
    card.className = 'setup-card setup-card-wide';
    card.style.cssText = 'border:none; box-shadow:none; background:transparent;';

    // Header — matches fields.js / special_activities.js pattern
    card.innerHTML = '<div class="setup-card-header" style="margin-bottom:20px;">' +
        '<span class="setup-step-pill">Rules</span>' +
        '<div class="setup-card-text">' +
        '<h3>Scheduling Rules</h3>' +
        '<p>Configure constraints the scheduler enforces during generation and manual edits.</p>' +
        '</div></div>';

    card.appendChild(renderSequenceRulesSection());
    card.appendChild(renderCooldownSection());
    card.appendChild(renderSportRulesSection());

    wrapper.appendChild(card);
    container.appendChild(wrapper);
}

// =========================================================================
// SECTION BUILDER (matches detail-section pattern from fields.js)
// =========================================================================

function createSection(title, description) {
    var wrapper = document.createElement('div');
    wrapper.className = 'detail-section';
    wrapper.style.cssText = 'margin-bottom:16px;';

    var header = document.createElement('div');
    header.className = 'detail-section-header';

    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'flex:1;';
    titleEl.innerHTML = '<span class="detail-section-title">' + title + '</span>' +
        '<div class="detail-section-summary" style="margin-top:2px;">' + description + '</div>';

    var caret = document.createElement('span');
    caret.style.cssText = 'transition:transform 0.2s; color:var(--slate-400, #94A3B8);';
    caret.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>';

    header.appendChild(titleEl);
    header.appendChild(caret);

    var body = document.createElement('div');
    body.className = 'detail-section-body';
    body.style.display = 'block';

    header.onclick = function() {
        var isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        caret.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
    };

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
}

// =========================================================================
// SECTION 1: SEQUENCE RULES
// =========================================================================

function renderSequenceRulesSection() {
    var section = createSection(
        'Activity Sequence Rules',
        'Prevent activities from being scheduled immediately before or after each other.'
    );

    var body = section.querySelector('.detail-section-body');
    var rules = getSequenceRules();

    if (rules.length > 0) {
        var list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        rules.forEach(function(rule, idx) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); flex-wrap:wrap;';

            var dirLabels = {
                'a_before_b': 'cannot be right before',
                'b_before_a': 'cannot be right after',
                'either': 'cannot be adjacent to'
            };

            var pillStyle = 'font-weight:600; color:var(--teal-dark, #0F5F6E); background:var(--teal-tint, #e6f4f7); padding:4px 10px; border-radius:var(--radius-xs, 6px); font-size:0.85rem;';

            row.innerHTML =
                '<span style="' + pillStyle + '">' + esc(rule.activityA) + '</span>' +
                '<span style="color:var(--slate-500, #6B7280); font-size:0.8rem; flex-shrink:0;">' + (dirLabels[rule.direction] || rule.direction) + '</span>' +
                '<span style="' + pillStyle + '">' + esc(rule.activityB) + '</span>' +
                '<span style="flex:1;"></span>';

            var delBtn = document.createElement('button');
            delBtn.textContent = '\u2715';
            delBtn.title = 'Remove this rule';
            delBtn.style.cssText = 'width:28px; height:28px; border-radius:var(--radius-xs, 6px); border:1px solid #fecaca; background:#fef2f2; color:#dc2626; cursor:pointer; font-size:0.9rem; font-weight:600; flex-shrink:0;';
            delBtn.onclick = (function(i) {
                return function() {
                    if (!confirm('Remove this sequence rule?')) return;
                    var updated = getSequenceRules().filter(function(_, j) { return j !== i; });
                    saveSequenceRules(updated);
                    renderRulesTab(document.getElementById('rules'));
                };
            })(idx);
            row.appendChild(delBtn);
            list.appendChild(row);
        });

        body.appendChild(list);
    } else {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:var(--slate-400, #94A3B8); font-size:0.9rem; background:var(--slate-50, #F8FAFC); border-radius:var(--radius-sm, 8px); margin-bottom:16px; border:1px dashed var(--slate-300, #CBD5E1);';
        empty.textContent = 'No sequence rules configured yet. Add one below.';
        body.appendChild(empty);
    }

    // Add new rule form
    var form = document.createElement('div');
    form.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:14px; background:var(--teal-tint-bg, #f0f9fb); border:1px solid var(--teal-border, #b2dce6); border-radius:var(--radius-sm, 8px);';

    var activities = getAllActivityNames();
    var optionsHtml = '<option value="">-- Select Activity --</option>' +
        activities.map(function(a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join('');

    var selectStyle = 'padding:8px 10px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); font-size:0.85rem; min-width:150px; background:white; font-family:var(--font-body);';

    form.innerHTML =
        '<select id="seq-rule-a" style="' + selectStyle + '">' + optionsHtml + '</select>' +
        '<select id="seq-rule-dir" style="' + selectStyle + '">' +
        '<option value="a_before_b">cannot be right before</option>' +
        '<option value="b_before_a">cannot be right after</option>' +
        '<option value="either">cannot be adjacent to</option>' +
        '</select>' +
        '<select id="seq-rule-b" style="' + selectStyle + '">' + optionsHtml + '</select>';

    var addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Rule';
    addBtn.style.cssText = 'padding:8px 18px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-full, 999px); cursor:pointer; font-weight:600; font-size:0.85rem; box-shadow:0 2px 5px rgba(20,125,145,0.3);';
    addBtn.onclick = function() {
        var a = document.getElementById('seq-rule-a').value;
        var b = document.getElementById('seq-rule-b').value;
        var dir = document.getElementById('seq-rule-dir').value;
        if (!a || !b) { alert('Please select both activities.'); return; }
        if (a === b) { alert('The two activities must be different.'); return; }
        var existing = getSequenceRules();
        var dup = existing.some(function(r) {
            return (r.activityA === a && r.activityB === b && r.direction === dir) ||
                   (r.activityA === b && r.activityB === a && r.direction === dir);
        });
        if (dup) { alert('This rule already exists.'); return; }
        existing.push({ activityA: a, activityB: b, direction: dir });
        saveSequenceRules(existing);
        renderRulesTab(document.getElementById('rules'));
    };
    form.appendChild(addBtn);
    body.appendChild(form);

    var hint = document.createElement('div');
    hint.style.cssText = 'margin-top:12px; font-size:0.8rem; color:var(--slate-500, #6B7280); padding:12px; background:var(--slate-50, #F9FAFB); border-radius:var(--radius-sm, 8px); border-left:3px solid var(--teal-primary, #147D91); line-height:1.5;';
    hint.innerHTML = '<strong>Example:</strong> If you add "Swim cannot be right before Art", ' +
        'the scheduler will never place Art in the slot immediately after Swim for any bunk. ' +
        'During manual edits, a warning dialog will appear with an option to override.';
    body.appendChild(hint);

    return section;
}

// =========================================================================
// SECTION 2: PINNED TILE COOLDOWNS
// =========================================================================

function renderCooldownSection() {
    var section = createSection(
        'Location Cooldowns',
        'Block a location for extra time slots after a pinned tile ends.'
    );

    var body = section.querySelector('.detail-section-body');
    var defaults = getPinnedTileDefaults();
    var entries = Object.entries(defaults);

    if (entries.length > 0) {
        var list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        entries.forEach(function(entry) {
            var tileName = entry[0];
            var val = entry[1];
            var location = typeof val === 'string' ? val : (val ? val.location || '' : '');
            var cooldown = (typeof val === 'object' && val) ? (val.cooldownSlots || 0) : 0;

            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); flex-wrap:wrap;';

            var info = document.createElement('div');
            info.style.cssText = 'flex:1; min-width:160px;';
            info.innerHTML =
                '<div style="font-weight:600; color:var(--slate-800, #1E293B);">' + esc(tileName) + '</div>' +
                '<div style="font-size:0.8rem; color:var(--slate-500, #6B7280); margin-top:2px;">' + (esc(location) || '<em style="color:var(--slate-400);">No location set</em>') + '</div>';
            row.appendChild(info);

            var coolWrap = document.createElement('div');
            coolWrap.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

            var coolLabel = document.createElement('span');
            coolLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
            coolLabel.textContent = 'Cooldown:';
            coolWrap.appendChild(coolLabel);

            var coolInput = document.createElement('input');
            coolInput.type = 'number';
            coolInput.min = '0';
            coolInput.max = '5';
            coolInput.value = cooldown;
            coolInput.style.cssText = 'width:50px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem; background:white;';
            coolInput.onchange = (function(name) {
                return function() {
                    var v = Math.min(5, Math.max(0, parseInt(this.value) || 0));
                    this.value = v;
                    var updated = getPinnedTileDefaults();
                    if (typeof updated[name] === 'string') {
                        updated[name] = { location: updated[name], cooldownSlots: v };
                    } else {
                        updated[name] = Object.assign({}, updated[name] || {}, { cooldownSlots: v });
                    }
                    savePinnedTileDefaults(updated);
                    var inp = this;
                    inp.style.borderColor = 'var(--teal-primary, #147D91)';
                    setTimeout(function() { inp.style.borderColor = 'var(--slate-300, #D1D5DB)'; }, 800);
                };
            })(tileName);
            coolWrap.appendChild(coolInput);

            var slotsLabel = document.createElement('span');
            slotsLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
            slotsLabel.textContent = 'slot(s) after';
            coolWrap.appendChild(slotsLabel);

            row.appendChild(coolWrap);
            list.appendChild(row);
        });

        body.appendChild(list);
    } else {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:var(--slate-400, #94A3B8); font-size:0.9rem; background:var(--slate-50, #F8FAFC); border-radius:var(--radius-sm, 8px); margin-bottom:16px; border:1px dashed var(--slate-300, #CBD5E1);';
        empty.innerHTML = 'No pinned tile defaults configured.<br><span style="font-size:0.8rem;">Set them up in the <strong>Locations</strong> tab under Pinned Tile Defaults.</span>';
        body.appendChild(empty);
    }

    var infoBox = document.createElement('div');
    infoBox.style.cssText = 'margin-top:12px; font-size:0.8rem; color:var(--slate-500, #6B7280); padding:12px; background:var(--slate-50, #F9FAFB); border-radius:var(--radius-sm, 8px); border-left:3px solid var(--teal-primary, #147D91); line-height:1.5;';
    infoBox.innerHTML = '<strong>How it works:</strong> If "Lunch" occupies "Gym" with cooldown = 1, ' +
        'the scheduler won\'t place any activity in the Gym for 1 additional slot after Lunch. ' +
        'Enforced during both auto-generate and manual edits. Set to 0 for no cooldown.';
    body.appendChild(infoBox);

    return section;
}

// =========================================================================
// SECTION 3: SPORTS RULES (moved from fields.js)
// =========================================================================

function renderSportRulesSection() {
    var allSports = getAllSportsFromFields();
    var sportMeta = getSportMetaData();

    var section = createSection(
        'Sports Player Requirements',
        allSports.length > 0
            ? allSports.length + ' sport' + (allSports.length !== 1 ? 's' : '') + ' configured'
            : 'No sports configured yet.'
    );

    var body = section.querySelector('.detail-section-body');

    if (allSports.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:20px; text-align:center; color:var(--slate-400, #94A3B8); font-size:0.9rem; background:var(--slate-50, #F8FAFC); border-radius:var(--radius-sm, 8px); border:1px dashed var(--slate-300, #CBD5E1);';
        empty.textContent = 'No sports configured yet. Add sports to fields in the Fields tab.';
        body.appendChild(empty);
        return section;
    }

    var hintBox = document.createElement('div');
    hintBox.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280); padding:12px; background:var(--slate-50, #F9FAFB); border-radius:var(--radius-sm, 8px); border-left:3px solid var(--teal-primary, #147D91); line-height:1.5; margin-bottom:16px;';
    hintBox.innerHTML = '<strong>How this works:</strong> Set minimum and maximum players for each sport. ' +
        'The scheduler will try to match bunks appropriately based on their sizes. ' +
        'If a bunk is too small, it may be paired with another bunk. ' +
        'If combined bunks are slightly over the max, the scheduler will still prefer a valid sport over "Free".';
    body.appendChild(hintBox);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:16px;';

    var sortedSports = allSports.slice().sort();

    sortedSports.forEach(function(sport) {
        var meta = sportMeta[sport] || {};

        var row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px);';

        var nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight:500; color:var(--slate-700, #374151); flex:1;';
        nameEl.textContent = sport;
        row.appendChild(nameEl);

        var inputsWrap = document.createElement('div');
        inputsWrap.style.cssText = 'display:flex; align-items:center; gap:16px;';

        // Min
        var minGroup = document.createElement('div');
        minGroup.style.cssText = 'display:flex; align-items:center; gap:6px;';
        var minLabel = document.createElement('span');
        minLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
        minLabel.textContent = 'Min:';
        var minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.min = '1';
        minInput.value = meta.minPlayers || '';
        minInput.placeholder = '\u2014';
        minInput.style.cssText = 'width:60px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem;';
        minInput.dataset.sport = sport;
        minInput.dataset.type = 'min';
        minGroup.appendChild(minLabel);
        minGroup.appendChild(minInput);
        inputsWrap.appendChild(minGroup);

        // Max
        var maxGroup = document.createElement('div');
        maxGroup.style.cssText = 'display:flex; align-items:center; gap:6px;';
        var maxLabel = document.createElement('span');
        maxLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
        maxLabel.textContent = 'Max:';
        var maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.min = '1';
        maxInput.value = meta.maxPlayers || '';
        maxInput.placeholder = '\u221e';
        maxInput.style.cssText = 'width:60px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem;';
        maxInput.dataset.sport = sport;
        maxInput.dataset.type = 'max';
        maxGroup.appendChild(maxLabel);
        maxGroup.appendChild(maxInput);
        inputsWrap.appendChild(maxGroup);

        row.appendChild(inputsWrap);
        list.appendChild(row);
    });

    body.appendChild(list);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'text-align:right;';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Rules';
    saveBtn.style.cssText = 'padding:8px 24px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-full, 999px); cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow:0 2px 5px rgba(20,125,145,0.3);';
    saveBtn.onclick = function() {
        var updatedMeta = getSportMetaData();

        body.querySelectorAll('input[data-sport]').forEach(function(input) {
            var sport = input.dataset.sport;
            var type = input.dataset.type;
            var val = parseInt(input.value) || null;

            if (!updatedMeta[sport]) updatedMeta[sport] = {};
            if (type === 'min') updatedMeta[sport].minPlayers = val;
            if (type === 'max') updatedMeta[sport].maxPlayers = val;
        });

        saveSportMetaData(updatedMeta);

        var orig = saveBtn.textContent;
        saveBtn.textContent = 'Saved';
        saveBtn.style.background = 'var(--teal-dark, #0F5F6E)';
        setTimeout(function() {
            saveBtn.textContent = orig;
            saveBtn.style.background = 'var(--teal-primary, #147D91)';
        }, 1200);
    };

    btnRow.appendChild(saveBtn);
    body.appendChild(btnRow);

    return section;
}

// =========================================================================
// INIT
// =========================================================================

function initRulesTab() {
    var container = document.getElementById('rules');
    if (!container) {
        console.warn('[SchedulingRules] #rules container not found');
        return;
    }

    renderRulesTab(container);
    _isInitialized = true;
    console.log('[SchedulingRules] Rules tab initialized');
}

// =========================================================================
// EXPORTS
// =========================================================================

window.initRulesTab = initRulesTab;

console.log('[SchedulingRules] Module loaded');

})();
