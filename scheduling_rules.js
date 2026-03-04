// ============================================================================
// scheduling_rules.js — CAMPISTRY RULES TAB (v4.0)
// ============================================================================
// Sections:
//   1. Activity Sequence Rules — chip-based picker with expandable groups
//   2. Location Cooldowns — minutes-based with "after [event]" input
//   3. Sports Player Requirements
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
    if (typeof window.requestCloudSync === 'function') {
        window.requestCloudSync();
    }
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

function getDisplayName(value) {
    if (value === GROUP_ALL_SPORTS) return 'All Sports';
    if (value === GROUP_ALL_SPECIALS) return 'All Specials';
    return value;
}

function isGroupValue(value) {
    return value === GROUP_ALL_SPORTS || value === GROUP_ALL_SPECIALS;
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
// CHIP-BASED ACTIVITY PICKER
// =========================================================================

function buildActivityPicker(containerId, selectedValue, onSelect) {
    var el = document.createElement('div');
    el.id = containerId;
    el.style.cssText = 'border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); padding:12px; background:white; min-width:200px;';

    var sports = getSportsList();
    var specials = getSpecialsList();
    var pinned = getPinnedTileNames();
    var currentVal = selectedValue || '';

    function chipStyle(isActive, isGroup) {
        var base = 'display:inline-block; padding:5px 12px; border-radius:var(--radius-full, 999px); font-size:0.82rem; cursor:pointer; margin:3px 4px 3px 0; border:1px solid; transition:all 0.15s;';
        if (isActive && isGroup) return base + ' background:#fed7aa; color:#7c2d12; border-color:#fdba74; font-weight:600;';
        if (isActive) return base + ' background:var(--teal-tint, #e6f4f7); color:var(--teal-dark, #0F5F6E); border-color:var(--teal-primary, #147D91); font-weight:600;';
        return base + ' background:var(--slate-50, #F8FAFC); color:var(--slate-600, #475569); border-color:var(--slate-200, #E5E7EB);';
    }

    function subChipStyle(isActive) {
        var base = 'display:inline-block; padding:3px 10px; border-radius:var(--radius-full, 999px); font-size:0.78rem; cursor:pointer; margin:2px 3px 2px 0; border:1px solid; transition:all 0.15s;';
        if (isActive) return base + ' background:var(--teal-tint, #e6f4f7); color:var(--teal-dark, #0F5F6E); border-color:var(--teal-primary, #147D91); font-weight:600;';
        return base + ' background:white; color:var(--slate-500, #6B7280); border-color:var(--slate-200, #E5E7EB);';
    }

    var expandedSports = false;
    var expandedSpecials = false;
    var customMode = false;

    function render() {
        el.innerHTML = '';

        // -- Sports group --
        if (sports.length > 0) {
            var sportsRow = document.createElement('div');
            sportsRow.style.cssText = 'margin-bottom:8px;';

            // "Sports" parent chip
            var sportsChip = document.createElement('span');
            sportsChip.style.cssText = chipStyle(currentVal === GROUP_ALL_SPORTS, true);
            sportsChip.textContent = 'All Sports';
            sportsChip.onclick = function() {
                if (currentVal === GROUP_ALL_SPORTS) {
                    // Toggle expand instead
                    expandedSports = !expandedSports;
                } else {
                    currentVal = GROUP_ALL_SPORTS;
                    expandedSports = false;
                    onSelect(currentVal);
                }
                render();
            };
            sportsRow.appendChild(sportsChip);

            // Expand arrow
            var expandBtn = document.createElement('span');
            expandBtn.style.cssText = 'display:inline-block; padding:3px 6px; cursor:pointer; color:var(--slate-400, #94A3B8); font-size:0.75rem; vertical-align:middle;';
            expandBtn.textContent = expandedSports ? '\u25B2' : '\u25BC';
            expandBtn.title = expandedSports ? 'Collapse' : 'Choose a specific sport';
            expandBtn.onclick = function(e) {
                e.stopPropagation();
                expandedSports = !expandedSports;
                render();
            };
            sportsRow.appendChild(expandBtn);

            // Individual sport chips
            if (expandedSports) {
                var subRow = document.createElement('div');
                subRow.style.cssText = 'padding:6px 0 2px 16px;';
                sports.forEach(function(s) {
                    var chip = document.createElement('span');
                    chip.style.cssText = subChipStyle(currentVal === s);
                    chip.textContent = s;
                    chip.onclick = function() {
                        currentVal = s;
                        onSelect(currentVal);
                        render();
                    };
                    subRow.appendChild(chip);
                });
                sportsRow.appendChild(subRow);
            }

            el.appendChild(sportsRow);
        }

        // -- Specials group --
        if (specials.length > 0) {
            var specialsRow = document.createElement('div');
            specialsRow.style.cssText = 'margin-bottom:8px;';

            var specialsChip = document.createElement('span');
            specialsChip.style.cssText = chipStyle(currentVal === GROUP_ALL_SPECIALS, true);
            specialsChip.textContent = 'All Specials';
            specialsChip.onclick = function() {
                if (currentVal === GROUP_ALL_SPECIALS) {
                    expandedSpecials = !expandedSpecials;
                } else {
                    currentVal = GROUP_ALL_SPECIALS;
                    expandedSpecials = false;
                    onSelect(currentVal);
                }
                render();
            };
            specialsRow.appendChild(specialsChip);

            var expandBtn2 = document.createElement('span');
            expandBtn2.style.cssText = 'display:inline-block; padding:3px 6px; cursor:pointer; color:var(--slate-400, #94A3B8); font-size:0.75rem; vertical-align:middle;';
            expandBtn2.textContent = expandedSpecials ? '\u25B2' : '\u25BC';
            expandBtn2.title = expandedSpecials ? 'Collapse' : 'Choose a specific special';
            expandBtn2.onclick = function(e) {
                e.stopPropagation();
                expandedSpecials = !expandedSpecials;
                render();
            };
            specialsRow.appendChild(expandBtn2);

            if (expandedSpecials) {
                var subRow2 = document.createElement('div');
                subRow2.style.cssText = 'padding:6px 0 2px 16px;';
                specials.forEach(function(s) {
                    var chip = document.createElement('span');
                    chip.style.cssText = subChipStyle(currentVal === s);
                    chip.textContent = s;
                    chip.onclick = function() {
                        currentVal = s;
                        onSelect(currentVal);
                        render();
                    };
                    subRow2.appendChild(chip);
                });
                specialsRow.appendChild(subRow2);
            }

            el.appendChild(specialsRow);
        }

        // -- Pinned tiles as individual chips --
        if (pinned.length > 0) {
            var pinnedRow = document.createElement('div');
            pinnedRow.style.cssText = 'margin-bottom:8px;';
            pinned.forEach(function(p) {
                var chip = document.createElement('span');
                chip.style.cssText = chipStyle(currentVal === p, false);
                chip.textContent = p;
                chip.onclick = function() {
                    currentVal = p;
                    onSelect(currentVal);
                    render();
                };
                pinnedRow.appendChild(chip);
            });
            el.appendChild(pinnedRow);
        }

        // -- Custom input --
        var customRow = document.createElement('div');
        customRow.style.cssText = 'margin-top:4px;';

        if (!customMode) {
            var customBtn = document.createElement('span');
            customBtn.style.cssText = 'display:inline-block; padding:5px 12px; border-radius:var(--radius-full, 999px); font-size:0.82rem; cursor:pointer; border:1px dashed var(--slate-300, #CBD5E1); color:var(--slate-500, #6B7280); margin:3px 0;';
            customBtn.textContent = '+ Custom';
            customBtn.onclick = function() {
                customMode = true;
                render();
            };
            customRow.appendChild(customBtn);
        } else {
            var customWrap = document.createElement('div');
            customWrap.style.cssText = 'display:flex; gap:6px; align-items:center;';
            var customInput = document.createElement('input');
            customInput.type = 'text';
            customInput.placeholder = 'e.g., Prayers';
            customInput.style.cssText = 'padding:6px 10px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); font-size:0.85rem; width:140px; font-family:var(--font-body);';
            // If current value is custom (not in any list), pre-fill
            var isCurrentCustom = currentVal && currentVal !== GROUP_ALL_SPORTS && currentVal !== GROUP_ALL_SPECIALS &&
                sports.indexOf(currentVal) === -1 && specials.indexOf(currentVal) === -1 && pinned.indexOf(currentVal) === -1;
            if (isCurrentCustom) customInput.value = currentVal;

            var setBtn = document.createElement('button');
            setBtn.textContent = 'Set';
            setBtn.style.cssText = 'padding:5px 14px; background:var(--teal-primary, #147D91); color:white; border:none; border-radius:var(--radius-xs, 6px); cursor:pointer; font-size:0.82rem; font-weight:600;';
            setBtn.onclick = function() {
                var v = customInput.value.trim();
                if (v) {
                    currentVal = v;
                    onSelect(currentVal);
                    render();
                }
            };
            customInput.onkeyup = function(e) {
                if (e.key === 'Enter') setBtn.click();
            };

            var cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'padding:5px 10px; background:var(--slate-100, #F1F5F9); color:var(--slate-600, #475569); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-xs, 6px); cursor:pointer; font-size:0.82rem;';
            cancelBtn.onclick = function() {
                customMode = false;
                render();
            };

            customWrap.appendChild(customInput);
            customWrap.appendChild(setBtn);
            customWrap.appendChild(cancelBtn);
            customRow.appendChild(customWrap);
        }
        el.appendChild(customRow);

        // Show selected value label
        if (currentVal) {
            var selLabel = document.createElement('div');
            selLabel.style.cssText = 'margin-top:8px; padding:6px 10px; background:var(--teal-tint-bg, #f0f9fb); border-radius:var(--radius-xs, 6px); font-size:0.8rem; color:var(--teal-dark, #0F5F6E);';
            selLabel.innerHTML = 'Selected: <strong>' + esc(getDisplayName(currentVal)) + '</strong>';
            el.appendChild(selLabel);
        }
    }

    render();

    // Expose getter
    el._getValue = function() { return currentVal; };

    return el;
}

// =========================================================================
// SECTION 1: SEQUENCE RULES
// =========================================================================

function renderSequenceRulesSection() {
    var section = createSection(
        'Activity Sequence Rules',
        'Control which activities can or can\'t be scheduled back-to-back.'
    );

    var body = section.querySelector('.detail-section-body');
    var rules = getSequenceRules();

    // Existing rules list
    if (rules.length > 0) {
        var list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:20px;';

        rules.forEach(function(rule, idx) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--slate-50, #F8FAFC); border:1px solid var(--slate-200, #E5E7EB); border-radius:var(--radius-sm, 8px); flex-wrap:wrap;';

            var dirLabel = rule.direction === 'b_before_a' ? 'cannot be right after' : 'cannot be right before';

            var pillBase = 'font-weight:600; padding:4px 10px; border-radius:var(--radius-xs, 6px); font-size:0.85rem;';
            function getPillStyle(val) {
                if (isGroupValue(val)) return pillBase + ' color:#7c2d12; background:#fed7aa;';
                return pillBase + ' color:var(--teal-dark, #0F5F6E); background:var(--teal-tint, #e6f4f7);';
            }

            row.innerHTML =
                '<span style="' + getPillStyle(rule.activityA) + '">' + esc(getDisplayName(rule.activityA)) + '</span>' +
                '<span style="color:var(--slate-500, #6B7280); font-size:0.8rem; flex-shrink:0;">' + dirLabel + '</span>' +
                '<span style="' + getPillStyle(rule.activityB) + '">' + esc(getDisplayName(rule.activityB)) + '</span>' +
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

    // --- Add new rule builder ---
    var builderLabel = document.createElement('div');
    builderLabel.style.cssText = 'font-weight:600; font-size:0.9rem; color:var(--slate-700, #334155); margin-bottom:10px;';
    builderLabel.textContent = 'Add a new rule';
    body.appendChild(builderLabel);

    var builder = document.createElement('div');
    builder.style.cssText = 'padding:16px; background:var(--teal-tint-bg, #f0f9fb); border:1px solid var(--teal-border, #b2dce6); border-radius:var(--radius-sm, 8px);';

    // Two-column layout: left picker, direction, right picker
    var pickerRow = document.createElement('div');
    pickerRow.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start;';

    // Left picker
    var leftWrap = document.createElement('div');
    leftWrap.style.cssText = 'flex:1; min-width:200px;';
    var leftLabel = document.createElement('div');
    leftLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280); margin-bottom:6px; font-weight:500;';
    leftLabel.textContent = 'This activity...';
    leftWrap.appendChild(leftLabel);

    var selectedA = '';
    var pickerA = buildActivityPicker('seq-picker-a', '', function(val) { selectedA = val; });
    leftWrap.appendChild(pickerA);
    pickerRow.appendChild(leftWrap);

    // Direction
    var dirWrap = document.createElement('div');
    dirWrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:160px; padding-top:24px;';
    var dirSelect = document.createElement('select');
    dirSelect.id = 'seq-rule-dir';
    dirSelect.style.cssText = 'padding:8px 10px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); font-size:0.85rem; background:white; font-family:var(--font-body); text-align:center;';
    dirSelect.innerHTML = '<option value="a_before_b">cannot be right before</option><option value="b_before_a">cannot be right after</option>';
    dirWrap.appendChild(dirSelect);
    pickerRow.appendChild(dirWrap);

    // Right picker
    var rightWrap = document.createElement('div');
    rightWrap.style.cssText = 'flex:1; min-width:200px;';
    var rightLabel = document.createElement('div');
    rightLabel.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280); margin-bottom:6px; font-weight:500;';
    rightLabel.textContent = '...this activity';
    rightWrap.appendChild(rightLabel);

    var selectedB = '';
    var pickerB = buildActivityPicker('seq-picker-b', '', function(val) { selectedB = val; });
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
        if (!a || !b) { alert('Please select an activity on both sides.'); return; }
        if (a === b) { alert('The two selections must be different.'); return; }
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
    addRow.appendChild(addBtn);
    builder.appendChild(addRow);

    body.appendChild(builder);

    // Hint
    var hint = document.createElement('div');
    hint.style.cssText = 'margin-top:12px; font-size:0.8rem; color:var(--slate-500, #6B7280); padding:12px; background:var(--slate-50, #F9FAFB); border-radius:var(--radius-sm, 8px); border-left:3px solid var(--teal-primary, #147D91); line-height:1.5;';
    hint.innerHTML = '<strong>Examples:</strong> "All Sports cannot be right after Swim" prevents any sport from following Swim. ' +
        '"Prayers cannot be right after Lunch" uses a custom activity name. You can pick whole groups or individual activities.';
    body.appendChild(hint);

    return section;
}

// =========================================================================
// SECTION 2: LOCATION COOLDOWNS (minutes + "after" input)
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

            // Location name
            var locLabel = document.createElement('div');
            locLabel.style.cssText = 'min-width:100px;';
            locLabel.innerHTML = '<div style="font-weight:600; color:var(--slate-800, #1E293B);">' + (esc(location) || '<em style="color:var(--slate-400);">No location</em>') + '</div>';
            row.appendChild(locLabel);

            // "blocked for"
            var blockLabel = document.createElement('span');
            blockLabel.style.cssText = 'font-size:0.85rem; color:var(--slate-500, #6B7280);';
            blockLabel.textContent = 'blocked for';
            row.appendChild(blockLabel);

            // Minutes input
            var coolInput = document.createElement('input');
            coolInput.type = 'number';
            coolInput.min = '0';
            coolInput.max = '120';
            coolInput.step = '5';
            coolInput.value = cooldownMin;
            coolInput.placeholder = '0';
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

            // "min after"
            var afterLabel = document.createElement('span');
            afterLabel.style.cssText = 'font-size:0.85rem; color:var(--slate-500, #6B7280);';
            afterLabel.textContent = 'min after';
            row.appendChild(afterLabel);

            // Event name (the tile)
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

    // Info
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

        var inputsWrap = document.createElement('div');
        inputsWrap.style.cssText = 'display:flex; align-items:center; gap:16px;';

        ['min', 'max'].forEach(function(type) {
            var group = document.createElement('div');
            group.style.cssText = 'display:flex; align-items:center; gap:6px;';
            var label = document.createElement('span');
            label.style.cssText = 'font-size:0.8rem; color:var(--slate-500, #6B7280);';
            label.textContent = type === 'min' ? 'Min:' : 'Max:';
            var input = document.createElement('input');
            input.type = 'number';
            input.min = '1';
            input.value = (type === 'min' ? meta.minPlayers : meta.maxPlayers) || '';
            input.placeholder = type === 'min' ? '\u2014' : '\u221e';
            input.style.cssText = 'width:60px; padding:6px 8px; border:1px solid var(--slate-300, #D1D5DB); border-radius:var(--radius-xs, 6px); text-align:center; font-size:0.85rem;';
            input.dataset.sport = sport;
            input.dataset.type = type;
            group.appendChild(label);
            group.appendChild(input);
            inputsWrap.appendChild(group);
        });

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
        setTimeout(function() { saveBtn.textContent = orig; saveBtn.style.background = 'var(--teal-primary, #147D91)'; }, 1200);
    };
    btnRow.appendChild(saveBtn);
    body.appendChild(btnRow);

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
