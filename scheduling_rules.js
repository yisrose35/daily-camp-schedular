// ============================================================================
// scheduling_rules.js — CAMPISTRY RULES TAB (v6.0)
// ============================================================================
// Sections:
//   1. Activity Sequence Rules — time-based gaps, multi-select chips, custom
//   2. Location Cooldowns — minutes-based with sentence layout
//   3. Sports Player Requirements
//
// Data model for sequence rules:
//   { activityA, activityB, direction, gapMinutes }
//   - activityA/B: string | string[] | "__ALL_SPORTS__" | "__ALL_SPECIALS__"
//   - direction: "before" | "after" | "both"
//   - gapMinutes: number (e.g., 30)
// ============================================================================

(function() {
'use strict';

console.log('[SchedulingRules] Loading Rules tab...');

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
    var settings = loadSettings();
    return (settings.schedulingConstraints && settings.schedulingConstraints.sequenceRules) ? settings.schedulingConstraints.sequenceRules : [];
}

function saveSequenceRules(rules) {
    var settings = loadSettings();
    if (!settings.schedulingConstraints) settings.schedulingConstraints = {};
    settings.schedulingConstraints.sequenceRules = rules;
    saveSettings('schedulingConstraints', settings.schedulingConstraints);
}

function getPinnedTileDefaults() {
    var settings = loadSettings();
    return settings.pinnedTileDefaults || {};
}

function savePinnedTileDefaults(defaults) {
    saveSettings('pinnedTileDefaults', defaults);
}

function getSportMetaData() {
    var settings = loadSettings();
    return (settings.app1 && settings.app1.sportMetaData) ? settings.app1.sportMetaData : {};
}

function saveSportMetaData(meta) {
    var settings = loadSettings();
    if (!settings.app1) settings.app1 = {};
    settings.app1.sportMetaData = meta;
    saveSettings('app1', settings.app1);
    if (typeof window.requestCloudSync === 'function') window.requestCloudSync();
}

// =========================================================================
// ACTIVITY HELPERS
// =========================================================================

var GROUP_ALL_SPORTS = '__ALL_SPORTS__';
var GROUP_ALL_SPECIALS = '__ALL_SPECIALS__';

function getSportsList() {
    if (window.getAllGlobalSports) return window.getAllGlobalSports().slice().sort();
    var settings = loadSettings();
    var fields = (settings.app1 && settings.app1.fields) ? settings.app1.fields : [];
    var sports = new Set();
    fields.forEach(function(f) { (f.activities || []).forEach(function(a) { sports.add(a); }); });
    return Array.from(sports).sort();
}

function getSpecialsList() {
    var settings = loadSettings();
    var specials = (settings.app1 && settings.app1.specialActivities) ? settings.app1.specialActivities : [];
    return specials.map(function(s) { return s.name; }).filter(Boolean).sort();
}

function getPinnedTileNames() {
    return Object.keys(getPinnedTileDefaults()).sort();
}

function isGroupValue(value) {
    return value === GROUP_ALL_SPORTS || value === GROUP_ALL_SPECIALS;
}

function formatRuleValue(val) {
    if (val === GROUP_ALL_SPORTS) return 'Sports';
    if (val === GROUP_ALL_SPECIALS) return 'Specials';
    if (Array.isArray(val)) return val.join(', ');
    return val || '';
}

function formatDirection(dir, gap) {
    var mins = gap ? gap + ' min' : '';
    if (dir === 'before') return 'cannot be within ' + mins + ' before';
    if (dir === 'after') return 'cannot be within ' + mins + ' after';
    return 'cannot be within ' + mins + ' of';
}

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =========================================================================
// MAIN RENDER
// =========================================================================

function renderRulesTab(container) {
    container.innerHTML = '';

    var wrapper = document.createElement('div');
    wrapper.className = 'setup-grid';

    var card = document.createElement('section');
    card.className = 'setup-card setup-card-wide';
    card.style.cssText = 'border:none; box-shadow:none; background:transparent;';

    card.innerHTML = '<div class="setup-card-header" style="margin-bottom:20px;">' +
        '<span class="setup-step-pill">Rules</span>' +
        '<div class="setup-card-text">' +
        '<h3>Scheduling Rules</h3>' +
        '<p>Set constraints the scheduler follows when building and editing the daily schedule.</p>' +
        '</div></div>';

    card.appendChild(renderSequenceRulesSection());
    card.appendChild(renderCooldownSection());
    card.appendChild(renderSportRulesSection());

    wrapper.appendChild(card);
    container.appendChild(wrapper);
}

// =========================================================================
// SECTION BUILDER
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
    caret.style.cssText = 'transition:transform 0.2s; color:var(--slate-400, #94A3B8); transform:rotate(-90deg);';
    caret.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>';

    header.appendChild(titleEl);
    header.appendChild(caret);

    var body = document.createElement('div');
    body.className = 'detail-section-body';
    body.style.display = 'none';

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
// MULTI-SELECT CHIP PICKER
// =========================================================================

function buildActivityPicker(containerId) {
    var el = document.createElement('div');
    el.id = containerId;
    el.style.cssText = 'border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); padding:12px; background:white; min-width:220px;';

    var sports = getSportsList();
    var specials = getSpecialsList();
    var pinned = getPinnedTileNames();

    var expanded = { sports: false, specials: false };
    var selectedItems = new Set();
    var groupSelected = { sports: false, specials: false };
    var customMode = false;
    var customValue = '';

    // Styles
    var chipBase = 'display:inline-flex; align-items:center; gap:4px; padding:5px 12px; border-radius:var(--radius-full, 999px); font-size:0.82rem; cursor:pointer; margin:3px 4px 3px 0; border:1px solid; transition:all 0.15s; user-select:none;';
    var subChipBase = 'display:inline-flex; align-items:center; gap:3px; padding:3px 10px; border-radius:var(--radius-full, 999px); font-size:0.78rem; cursor:pointer; margin:2px 3px 2px 0; border:1px solid; transition:all 0.15s; user-select:none;';

    function groupStyle(a) {
        if (a) return chipBase + ' background:#fed7aa; color:#7c2d12; border-color:#fdba74; font-weight:600;';
        return chipBase + ' background:var(--slate-50, #F8FAFC); color:var(--slate-600, #475569); border-color:var(--slate-200, #E5E7EB);';
    }
    function itemStyle(a) {
        if (a) return subChipBase + ' background:var(--teal-tint, #e6f4f7); color:var(--teal-dark, #0F5F6E); border-color:var(--teal-primary, #147D91); font-weight:600;';
        return subChipBase + ' background:white; color:var(--slate-500, #6B7280); border-color:var(--slate-200, #E5E7EB);';
    }
    function pinnedStyle(a) {
        if (a) return chipBase + ' background:var(--teal-tint, #e6f4f7); color:var(--teal-dark, #0F5F6E); border-color:var(--teal-primary, #147D91); font-weight:600;';
        return chipBase + ' background:var(--slate-50, #F8FAFC); color:var(--slate-600, #475569); border-color:var(--slate-200, #E5E7EB);';
    }

    function chevronSvg(open) {
        return open
            ? '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>'
            : '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
    }

    function renderGroup(name, items, groupKey, row) {
        var chip = document.createElement('span');
        chip.style.cssText = groupStyle(groupSelected[groupKey]);
        chip.textContent = name;
        chip.onclick = function() {
            if (groupSelected[groupKey]) {
                groupSelected[groupKey] = false;
                items.forEach(function(s) { selectedItems.delete(s); });
            } else {
                groupSelected[groupKey] = true;
                items.forEach(function(s) { selectedItems.add(s); });
            }
            render();
        };
        row.appendChild(chip);

        if (items.length > 0) {
            var expBtn = document.createElement('span');
            expBtn.style.cssText = 'display:inline-block; padding:3px 6px; cursor:pointer; color:var(--slate-400, #94A3B8); font-size:0.7rem; vertical-align:middle;';
            expBtn.innerHTML = chevronSvg(expanded[groupKey]);
            expBtn.title = expanded[groupKey] ? 'Collapse' : 'Pick specific';
            expBtn.onclick = function(e) { e.stopPropagation(); expanded[groupKey] = !expanded[groupKey]; render(); };
            row.appendChild(expBtn);
        }

        if (expanded[groupKey]) {
            var sub = document.createElement('div');
            sub.style.cssText = 'padding:4px 0 2px 12px;';
            items.forEach(function(s) {
                var c = document.createElement('span');
                c.style.cssText = itemStyle(selectedItems.has(s));
                c.textContent = s;
                c.onclick = function() {
                    if (selectedItems.has(s)) {
                        selectedItems.delete(s);
                        groupSelected[groupKey] = false;
                    } else {
                        selectedItems.add(s);
                        if (items.every(function(x) { return selectedItems.has(x); })) groupSelected[groupKey] = true;
                    }
                    render();
                };
                sub.appendChild(c);
            });
            row.appendChild(sub);
        }
    }

    function render() {
        el.innerHTML = '';

        if (sports.length > 0) {
            var sRow = document.createElement('div');
            sRow.style.cssText = 'margin-bottom:6px;';
            renderGroup('Sports', sports, 'sports', sRow);
            el.appendChild(sRow);
        }

        if (specials.length > 0) {
            var spRow = document.createElement('div');
            spRow.style.cssText = 'margin-bottom:6px;';
            renderGroup('Specials', specials, 'specials', spRow);
            el.appendChild(spRow);
        }

        if (pinned.length > 0) {
            var pRow = document.createElement('div');
            pRow.style.cssText = 'margin-bottom:6px;';
            pinned.forEach(function(p) {
                var c = document.createElement('span');
                c.style.cssText = pinnedStyle(selectedItems.has(p));
                c.textContent = p;
                c.onclick = function() {
                    if (selectedItems.has(p)) selectedItems.delete(p); else selectedItems.add(p);
                    render();
                };
                pRow.appendChild(c);
            });
            el.appendChild(pRow);
        }

        // Custom
        var cRow = document.createElement('div');
        cRow.style.cssText = 'margin-top:4px;';
        if (!customMode) {
            var cb = document.createElement('span');
            cb.style.cssText = 'display:inline-block; padding:5px 12px; border-radius:var(--radius-full, 999px); font-size:0.82rem; cursor:pointer; border:1px dashed var(--slate-300, #CBD5E1); color:var(--slate-500, #6B7280);';
            cb.textContent = '+ Custom';
            cb.onclick = function() { customMode = true; render(); };
            cRow.appendChild(cb);
        } else {
            var cw = document.createElement('div');
            cw.style.cssText = 'display:flex; gap:6px; align-items:center; margin-top:4px;';
            var ci = document.createElement('input');
            ci.type = 'text'; ci.placeholder = 'e.g., Prayers'; ci.value = customValue;
            ci.style.cssText = 'padding:6px 10px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); font-size:0.85rem; width:140px; font-family:var(--font-body);';
            var ab = document.createElement('button');
            ab.textContent = 'Add';
            ab.style.cssText = 'padding:5px 14px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-xs, 6px); cursor:pointer; font-size:0.82rem; font-weight:600;';
            ab.onclick = function() { var v = ci.value.trim(); if (v) { selectedItems.add(v); customValue = ''; customMode = false; render(); } };
            ci.onkeyup = function(e) { if (e.key === 'Enter') ab.click(); };
            var xb = document.createElement('button');
            xb.textContent = 'Cancel';
            xb.style.cssText = 'padding:5px 10px; background:var(--slate-100, #F1F5F9); color:var(--slate-600, #475569); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-xs, 6px); cursor:pointer; font-size:0.82rem;';
            xb.onclick = function() { customMode = false; customValue = ''; render(); };
            cw.appendChild(ci); cw.appendChild(ab); cw.appendChild(xb);
            cRow.appendChild(cw);
        }
        el.appendChild(cRow);

        // Selection summary
        var sel = Array.from(selectedItems);
        if (sel.length > 0) {
            var sum = document.createElement('div');
            sum.style.cssText = 'margin-top:8px; padding:6px 10px; background:var(--teal-tint-bg, #f0f9fb); border-radius:var(--radius-xs, 6px); font-size:0.8rem; color:var(--teal-dark, #0F5F6E); display:flex; flex-wrap:wrap; gap:4px; align-items:center;';
            sum.innerHTML = '<span style="font-weight:500; margin-right:4px;">Selected:</span>';
            sel.forEach(function(item) {
                var tag = document.createElement('span');
                tag.style.cssText = 'display:inline-flex; align-items:center; gap:3px; padding:2px 8px; background:var(--teal-tint, #e6f4f7); border-radius:var(--radius-full, 999px); font-size:0.78rem; font-weight:500;';
                tag.innerHTML = esc(item) + ' <span style="cursor:pointer; color:var(--slate-400); font-size:0.7rem; margin-left:2px;" title="Remove">\u2715</span>';
                tag.querySelector('span').onclick = function() {
                    selectedItems.delete(item);
                    if (sports.indexOf(item) !== -1) groupSelected.sports = false;
                    if (specials.indexOf(item) !== -1) groupSelected.specials = false;
                    render();
                };
                sum.appendChild(tag);
            });
            el.appendChild(sum);
        }
    }

    render();

    el._getValue = function() {
        var sel = Array.from(selectedItems);
        if (sel.length === 0) return null;
        if (groupSelected.sports && sports.length > 0) {
            var nonSports = sel.filter(function(s) { return sports.indexOf(s) === -1; });
            if (nonSports.length === 0) return GROUP_ALL_SPORTS;
        }
        if (groupSelected.specials && specials.length > 0) {
            var nonSpecials = sel.filter(function(s) { return specials.indexOf(s) === -1; });
            if (nonSpecials.length === 0) return GROUP_ALL_SPECIALS;
        }
        if (sel.length === 1) return sel[0];
        return sel;
    };

    return el;
}

// =========================================================================
// SECTION 1: SEQUENCE RULES
// =========================================================================

function renderSequenceRulesSection() {
    var section = createSection(
        'Activity Sequence Rules',
        'Control which activities can or can\'t be scheduled near each other.'
    );

    var body = section.querySelector('.detail-section-body');
    var rules = getSequenceRules();

    // Existing rules
    if (rules.length > 0) {
        var list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:20px;';

        rules.forEach(function(rule, idx) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); flex-wrap:wrap;';

            var pillBase = 'font-weight:600; padding:4px 10px; border-radius:var(--radius-xs, 6px); font-size:0.85rem; ';
            function ps(val) {
                if (isGroupValue(val)) return pillBase + 'color:#7c2d12; background:#fed7aa;';
                return pillBase + 'color:var(--teal-dark, #0F5F6E); background:var(--teal-tint, #e6f4f7);';
            }

            var gap = rule.gapMinutes || 30;
            var dirText = formatDirection(rule.direction, gap);

            row.innerHTML =
                '<span style="' + ps(rule.activityA) + '">' + esc(formatRuleValue(rule.activityA)) + '</span>' +
                '<span style="color:var(--slate-500, #6B7280); font-size:0.8rem; flex-shrink:0;">' + dirText + '</span>' +
                '<span style="' + ps(rule.activityB) + '">' + esc(formatRuleValue(rule.activityB)) + '</span>' +
                '<span style="flex:1;"></span>';

            var delBtn = document.createElement('button');
            delBtn.textContent = '\u2715';
            delBtn.title = 'Remove this rule';
            delBtn.style.cssText = 'width:28px; height:28px; border-radius:var(--radius-xs, 6px); border:1px solid #fecaca; background:#fef2f2; color:#dc2626; cursor:pointer; font-size:0.9rem; font-weight:600; flex-shrink:0;';
            delBtn.onclick = (function(i) {
                return function() {
                    if (!confirm('Remove this rule?')) return;
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
        empty.style.cssText = 'padding:20px; text-align:center; color:var(--slate-400, #94A3B8); font-size:0.9rem; background:var(--slate-50, #F8FAFC); border-radius:var(--radius-sm, 8px); margin-bottom:20px; border:1px dashed var(--slate-300, #CBD5E1);';
        empty.textContent = 'No sequence rules configured yet. Add one below.';
        body.appendChild(empty);
    }

    // --- Builder ---
    var builderLabel = document.createElement('div');
    builderLabel.style.cssText = 'font-weight:600; font-size:0.9rem; color:var(--slate-700, #334155); margin-bottom:10px;';
    builderLabel.textContent = 'Add a new rule';
    body.appendChild(builderLabel);

    var builder = document.createElement('div');
    builder.style.cssText = 'padding:16px; background:var(--teal-tint-bg, #f0f9fb); border:1px solid var(--teal-border, #b2dce6); border-radius:var(--radius-sm, 8px);';

    var pickerRow = document.createElement('div');
    pickerRow.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start;';

    // Left picker
    var leftWrap = document.createElement('div');
    leftWrap.style.cssText = 'flex:1; min-width:220px;';
    var leftLabel = document.createElement('div');
    leftLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280); margin-bottom:6px; font-weight:500;';
    leftLabel.textContent = 'This activity...';
    leftWrap.appendChild(leftLabel);
    var pickerA = buildActivityPicker('seq-picker-a');
    leftWrap.appendChild(pickerA);
    pickerRow.appendChild(leftWrap);

    // Center: direction + gap
    var centerWrap = document.createElement('div');
    centerWrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:180px; padding-top:28px; gap:10px;';

    // Direction sentence: "cannot be within [__] min [before ▼] "
    var sentenceRow = document.createElement('div');
    sentenceRow.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:6px; justify-content:center;';

    var lbl1 = document.createElement('span');
    lbl1.style.cssText = 'font-size:0.85rem; color:var(--slate-600, #475569);';
    lbl1.textContent = 'cannot be within';
    sentenceRow.appendChild(lbl1);

    var gapInput = document.createElement('input');
    gapInput.type = 'number';
    gapInput.id = 'seq-gap-input';
    gapInput.min = '1';
    gapInput.max = '120';
    gapInput.step = '5';
    gapInput.placeholder = 'min';
    gapInput.style.cssText = 'width:56px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem; background:white;';
    sentenceRow.appendChild(gapInput);

    var lbl2 = document.createElement('span');
    lbl2.style.cssText = 'font-size:0.85rem; color:var(--slate-600, #475569);';
    lbl2.textContent = 'min';
    sentenceRow.appendChild(lbl2);

    var dirSelect = document.createElement('select');
    dirSelect.id = 'seq-rule-dir';
    dirSelect.style.cssText = 'padding:6px 10px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); font-size:0.85rem; background:white; font-family:var(--font-body);';
    dirSelect.innerHTML =
        '<option value="before">before</option>' +
        '<option value="after">after</option>' +
        '<option value="both">before or after</option>';
    sentenceRow.appendChild(dirSelect);

    centerWrap.appendChild(sentenceRow);
    pickerRow.appendChild(centerWrap);

    // Right picker
    var rightWrap = document.createElement('div');
    rightWrap.style.cssText = 'flex:1; min-width:220px;';
    var rightLabel = document.createElement('div');
    rightLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280); margin-bottom:6px; font-weight:500;';
    rightLabel.textContent = '...this activity';
    rightWrap.appendChild(rightLabel);
    var pickerB = buildActivityPicker('seq-picker-b');
    rightWrap.appendChild(pickerB);
    pickerRow.appendChild(rightWrap);

    builder.appendChild(pickerRow);

    // Add button
    var addRow = document.createElement('div');
    addRow.style.cssText = 'margin-top:14px; text-align:center;';
    var addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Rule';
    addBtn.style.cssText = 'padding:10px 28px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-full, 999px); cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow:0 2px 5px rgba(20,125,145,0.3);';
    addBtn.onclick = function() {
        var a = pickerA._getValue();
        var b = pickerB._getValue();
        var dir = dirSelect.value;
        var gap = parseInt(gapInput.value);
        if (!a || !b) { alert('Please select at least one activity on each side.'); return; }
        if (!gap || gap < 1) { alert('Please enter the number of minutes.'); return; }
        var aStr = JSON.stringify(a);
        var bStr = JSON.stringify(b);
        if (aStr === bStr) { alert('The two sides must be different.'); return; }
        var existing = getSequenceRules();
        var dup = existing.some(function(r) {
            return (JSON.stringify(r.activityA) === aStr && JSON.stringify(r.activityB) === bStr && r.direction === dir) ||
                   (JSON.stringify(r.activityA) === bStr && JSON.stringify(r.activityB) === aStr && r.direction === dir);
        });
        if (dup) { alert('This rule already exists.'); return; }
        existing.push({ activityA: a, activityB: b, direction: dir, gapMinutes: gap });
        saveSequenceRules(existing);
        renderRulesTab(document.getElementById('rules'));
    };
    addRow.appendChild(addBtn);
    builder.appendChild(addRow);

    body.appendChild(builder);

    // Hint
    var hint = document.createElement('div');
    hint.style.cssText = 'margin-top:12px; font-size:0.8rem; color:var(--slate-500, #6B7280); padding:12px; background:var(--slate-50, #F9FAFB); border-radius:var(--radius-sm, 8px); border-left:3px solid var(--teal-primary, #147D91); line-height:1.5;';
    hint.innerHTML = '<strong>Examples:</strong> "Basketball cannot be within 30 min before Lunch" or "Sports cannot be within 45 min after Swim". ' +
        'Use "before or after" to block in both directions.';
    body.appendChild(hint);

    return section;
}

// =========================================================================
// SECTION 2: LOCATION COOLDOWNS
// =========================================================================

function renderCooldownSection() {
    var section = createSection(
        'Location Cooldowns',
        'Keep a location empty for a set amount of time after an event.'
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
            var cooldownMin = (typeof val === 'object' && val) ? (val.cooldownMinutes || 0) : 0;

            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); flex-wrap:wrap;';

            var locLabel = document.createElement('div');
            locLabel.style.cssText = 'min-width:100px;';
            locLabel.innerHTML = '<div style="font-weight:600; color:var(--slate-800, #1E293B);">' + (esc(location) || '<em style="color:var(--slate-400);">No location</em>') + '</div>';
            row.appendChild(locLabel);

            var t1 = document.createElement('span');
            t1.style.cssText = 'font-size:0.85rem; color:var(--slate-500, #6B7280);';
            t1.textContent = 'blocked for';
            row.appendChild(t1);

            var coolInput = document.createElement('input');
            coolInput.type = 'number';
            coolInput.min = '0'; coolInput.max = '120'; coolInput.step = '5';
            coolInput.value = cooldownMin; coolInput.placeholder = '0';
            coolInput.style.cssText = 'width:60px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem; background:white;';
            coolInput.onchange = (function(name) {
                return function() {
                    var v = Math.min(120, Math.max(0, parseInt(this.value) || 0));
                    this.value = v;
                    var updated = getPinnedTileDefaults();
                    if (typeof updated[name] === 'string') {
                        updated[name] = { location: updated[name], cooldownMinutes: v };
                    } else {
                        updated[name] = Object.assign({}, updated[name] || {}, { cooldownMinutes: v });
                    }
                    savePinnedTileDefaults(updated);
                    var inp = this;
                    inp.style.borderColor = 'var(--teal-primary, #147D91)';
                    setTimeout(function() { inp.style.borderColor = 'var(--slate-300, #D1D5DB)'; }, 800);
                };
            })(tileName);
            row.appendChild(coolInput);

            var t2 = document.createElement('span');
            t2.style.cssText = 'font-size:0.85rem; color:var(--slate-500, #6B7280);';
            t2.textContent = 'min after';
            row.appendChild(t2);

            var eventPill = document.createElement('span');
            eventPill.style.cssText = 'font-weight:600; color:var(--teal-dark, #0F5F6E); background:var(--teal-tint, #e6f4f7); padding:4px 10px; border-radius:var(--radius-xs, 6px); font-size:0.85rem;';
            eventPill.textContent = tileName;
            row.appendChild(eventPill);

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
    infoBox.innerHTML = '<strong>Example:</strong> Gym blocked for 45 min after Lunch means no activity can use the Gym for 45 minutes after Lunch ends. Set to 0 for no cooldown.';
    body.appendChild(infoBox);

    return section;
}

// =========================================================================
// SECTION 3: SPORTS PLAYER REQUIREMENTS
// =========================================================================

function renderSportRulesSection() {
    var allSports = getSportsList();
    var sportMeta = getSportMetaData();

    var section = createSection(
        'Sports Player Requirements',
        allSports.length > 0
            ? 'Set how many players each sport needs so the scheduler picks the right matchups.'
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
    hintBox.innerHTML = '<strong>How this works:</strong> Set min and max players per sport. The scheduler uses these to pair bunks by size and pick appropriate matchups.';
    body.appendChild(hintBox);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:16px;';

    allSports.forEach(function(sport) {
        var meta = sportMeta[sport] || {};
        var row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px);';

        var nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight:500; color:var(--slate-700, #374151); flex:1;';
        nameEl.textContent = sport;
        row.appendChild(nameEl);

        var iw = document.createElement('div');
        iw.style.cssText = 'display:flex; align-items:center; gap:16px;';

        ['min', 'max'].forEach(function(type) {
            var g = document.createElement('div');
            g.style.cssText = 'display:flex; align-items:center; gap:6px;';
            var l = document.createElement('span');
            l.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
            l.textContent = type === 'min' ? 'Min:' : 'Max:';
            var inp = document.createElement('input');
            inp.type = 'number'; inp.min = '1';
            inp.value = (type === 'min' ? meta.minPlayers : meta.maxPlayers) || '';
            inp.placeholder = type === 'min' ? '\u2014' : '\u221e';
            inp.style.cssText = 'width:60px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem;';
            inp.dataset.sport = sport; inp.dataset.type = type;
            g.appendChild(l); g.appendChild(inp); iw.appendChild(g);
        });

        row.appendChild(iw);
        list.appendChild(row);
    });

    body.appendChild(list);

    var br = document.createElement('div');
    br.style.cssText = 'text-align:right;';
    var sb = document.createElement('button');
    sb.textContent = 'Save Rules';
    sb.style.cssText = 'padding:8px 24px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-full, 999px); cursor:pointer; font-weight:600; font-size:0.9rem; box-shadow:0 2px 5px rgba(20,125,145,0.3);';
    sb.onclick = function() {
        var um = getSportMetaData();
        body.querySelectorAll('input[data-sport]').forEach(function(input) {
            var s = input.dataset.sport, t = input.dataset.type, v = parseInt(input.value) || null;
            if (!um[s]) um[s] = {};
            if (t === 'min') um[s].minPlayers = v;
            if (t === 'max') um[s].maxPlayers = v;
        });
        saveSportMetaData(um);
        var o = sb.textContent;
        sb.textContent = 'Saved'; sb.style.background = 'var(--teal-dark, #0F5F6E)';
        setTimeout(function() { sb.textContent = o; sb.style.background = 'var(--teal-primary, #147D91)'; }, 1200);
    };
    br.appendChild(sb);
    body.appendChild(br);

    return section;
}

// =========================================================================
// INIT & EXPORTS
// =========================================================================

function initRulesTab() {
    var container = document.getElementById('rules');
    if (!container) { console.warn('[SchedulingRules] #rules container not found'); return; }
    renderRulesTab(container);
    console.log('[SchedulingRules] Rules tab initialized');
}

window.initRulesTab = initRulesTab;
window.SEQUENCE_RULE_ALL_SPORTS = GROUP_ALL_SPORTS;
window.SEQUENCE_RULE_ALL_SPECIALS = GROUP_ALL_SPECIALS;

console.log('[SchedulingRules] Module loaded');

})();
