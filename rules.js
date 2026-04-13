// ============================================================================
// rules.js — CAMP SCHEDULING RULES v1.0
// ============================================================================
// Houses all cross-cutting scheduling "rules" that camps want the scheduler
// to respect. Sections:
//   1. Sports Rules (min/max players per sport)   — moved from facilities.js
//   2. Field Quality Groups                        — moved from facilities.js
//   3. Cooldown / Spacing Rules (new)             — keep X away from Y
//
// Data locations:
//   - sportMetaData, fieldCombos : settings.app1.sportMetaData / app1.fieldCombos
//   - fieldGroup / qualityRank   : settings.app1.fields[i]
//   - cooldowns                  : settings.schedulingRules.cooldowns[]
//
// Public API (window.SchedulingRules):
//   - getCooldownRules()
//   - isCandidateAllowed(candidate, template, opts)
//   - findForbiddenRanges(targetDescriptor, template, opts) -> [{start,end}]
// ============================================================================
(function () {
'use strict';

console.log('[RULES] rules.js v1.0 loading...');

// ──────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}
function loadSettings() { return (window.loadGlobalSettings && window.loadGlobalSettings()) || {}; }
function saveKey(k, v) { window.saveGlobalSettings && window.saveGlobalSettings(k, v); }
function uid(prefix) { return (prefix || 'r_') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function getFacilityNames() {
    const s = loadSettings();
    const facs = s.facilities || [];
    const fieldNames = (s.app1 && s.app1.fields ? s.app1.fields : []).map(f => f.name);
    const all = new Set();
    facs.forEach(f => f && f.name && all.add(f.name));
    fieldNames.forEach(n => n && all.add(n));
    return [...all].sort();
}
function getSpecialActivityNames() {
    const specials = (window.getAllSpecialActivities && window.getAllSpecialActivities()) || [];
    const names = new Set();
    specials.forEach(sp => { if (sp && sp.name) names.add(sp.name); });
    const s = loadSettings();
    const pinned = s.pinnedTileDefaults || {};
    Object.keys(pinned).forEach(n => names.add(n));
    return [...names].sort();
}
function getSportNames() {
    return (window.getAllGlobalSports && window.getAllGlobalSports()) || [];
}

// Activity-type buckets we can target with "any"
const ACTIVITY_TYPE_OPTIONS = [
    { value: 'sport',   label: 'Any Sport' },
    { value: 'swim',    label: 'Swim' },
    { value: 'lunch',   label: 'Lunch' },
    { value: 'snack',   label: 'Snack' },
    { value: 'special', label: 'Any Special' },
    { value: 'custom',  label: 'Any Custom' },
    { value: 'league',  label: 'League' },
    { value: 'dismissal', label: 'Dismissal' },
    { value: 'arrival', label: 'Arrival' }
];

// ──────────────────────────────────────────────────────────────────────────
// COOLDOWN RULES — data access
// ──────────────────────────────────────────────────────────────────────────
function getCooldownRules() {
    const s = loadSettings();
    const sr = s.schedulingRules || {};
    return Array.isArray(sr.cooldowns) ? sr.cooldowns : [];
}
function saveCooldownRules(rules) {
    const s = loadSettings();
    const sr = s.schedulingRules || {};
    sr.cooldowns = rules || [];
    saveKey('schedulingRules', sr);
}

// Descriptor matching.
// Descriptor shape: { kind: 'any' | 'type' | 'activity' | 'facility', value: string }
function blockMatchesDescriptor(block, desc) {
    if (!block || !desc) return false;
    if (desc.kind === 'any') return true;
    const bType = String(block.type || '').toLowerCase();
    const bEvent = String(block.event || '').toLowerCase().trim();
    const bSpecial = String(block._assignedSpecial || '').toLowerCase().trim();
    const bField = String(block.field || block._specialLocation || block.location || '').toLowerCase().trim();

    if (desc.kind === 'type') {
        const t = String(desc.value || '').toLowerCase().trim();
        if (!t) return false;
        if (t === 'sport' || t === 'sports') return bType === 'sport' || bType === 'sports';
        if (t === 'snack' || t === 'snacks') return bType === 'snack' || bType === 'snacks' || bEvent === 'snack' || bEvent === 'snacks';
        if (t === 'lunch') return bType === 'lunch' || bEvent === 'lunch';
        if (t === 'dismissal') return bType === 'dismissal' || bEvent === 'dismissal';
        if (t === 'arrival') return bType === 'arrival' || bEvent === 'arrival';
        if (t === 'swim') return bType === 'swim' || bEvent === 'swim';
        if (t === 'special') return bType === 'special';
        if (t === 'custom') return bType === 'custom';
        if (t === 'league') return bType === 'league' || bType === 'specialty_league';
        return bType === t || bEvent === t;
    }
    if (desc.kind === 'activity') {
        const v = String(desc.value || '').toLowerCase().trim();
        if (!v) return false;
        return bEvent === v || bSpecial === v;
    }
    if (desc.kind === 'facility') {
        const v = String(desc.value || '').toLowerCase().trim();
        if (!v) return false;
        return bField === v;
    }
    return false;
}

// candidate : { startMin, endMin, type, event, field, _assignedSpecial, _specialLocation }
// template  : array of blocks already placed on the bunk
// opts      : { auto: true/false }
function isCandidateAllowed(candidate, template, opts) {
    opts = opts || {};
    const auto = !!opts.auto;
    const rules = getCooldownRules();
    if (!rules.length || !candidate) return true;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.autoOnly && !auto) continue;
        if (!r.target || !r.reference) continue;
        if (!blockMatchesDescriptor(candidate, r.target)) continue;
        const minutes = Math.max(0, parseInt(r.minutes) || 0);
        if (minutes === 0) continue;
        for (let j = 0; j < template.length; j++) {
            const w = template[j];
            if (!w || w === candidate) continue;
            if (!blockMatchesDescriptor(w, r.reference)) continue;
            // gap when candidate is BEFORE the reference
            const gapBefore = (w.startMin || 0) - (candidate.endMin || 0);
            // gap when candidate is AFTER the reference
            const gapAfter  = (candidate.startMin || 0) - (w.endMin || 0);
            const timing = r.timing || 'both';
            if (timing === 'before' || timing === 'both') {
                if (gapBefore >= 0 && gapBefore < minutes) return false;
            }
            if (timing === 'after' || timing === 'both') {
                if (gapAfter >= 0 && gapAfter < minutes) return false;
            }
        }
    }
    return true;
}

// For optimizer: given what you're about to place (descriptor) and the current
// template, return forbidden [start,end] ranges where placement would violate.
function findForbiddenRanges(targetDescriptor, template, opts) {
    opts = opts || {};
    const auto = !!opts.auto;
    const out = [];
    const rules = getCooldownRules();
    if (!rules.length) return out;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.autoOnly && !auto) continue;
        if (!r.target || !r.reference) continue;
        // target descriptor must overlap with r.target
        if (!descriptorCanMatch(r.target, targetDescriptor)) continue;
        const minutes = Math.max(0, parseInt(r.minutes) || 0);
        if (minutes === 0) continue;
        for (let j = 0; j < template.length; j++) {
            const w = template[j];
            if (!blockMatchesDescriptor(w, r.reference)) continue;
            const timing = r.timing || 'both';
            if (timing === 'after' || timing === 'both') {
                // candidate after w forbidden if candidate.start < w.end + minutes
                out.push({ start: w.endMin, end: w.endMin + minutes, side: 'after' });
            }
            if (timing === 'before' || timing === 'both') {
                // candidate before w forbidden if candidate.end > w.start - minutes
                out.push({ start: w.startMin - minutes, end: w.startMin, side: 'before' });
            }
        }
    }
    return out;
}

function descriptorCanMatch(ruleDesc, candidateDesc) {
    if (!ruleDesc || !candidateDesc) return false;
    if (ruleDesc.kind === 'any' || candidateDesc.kind === 'any') return true;
    if (ruleDesc.kind === candidateDesc.kind) {
        return String(ruleDesc.value || '').toLowerCase() === String(candidateDesc.value || '').toLowerCase();
    }
    // type vs activity/facility — can't statically prove, allow (be conservative)
    return true;
}

// ──────────────────────────────────────────────────────────────────────────
// SPORTS RULES CARD
// ──────────────────────────────────────────────────────────────────────────
function renderSportsRulesCard(container) {
    if (!container) return;
    const s = loadSettings();
    const app1 = s.app1 || {};
    const meta = app1.sportMetaData || {};
    const sports = getSportNames();

    if (sports.length === 0) {
        container.innerHTML = `
            <div class="sport-rules-card">
                <div class="sport-rules-header"><div class="sport-rules-title">Sports Rules</div></div>
                <div class="sport-rules-body" style="display:block; padding:10px; text-align:center;">
                    <p class="muted" style="padding:10px;">No sports configured yet. Add sports to a facility first.</p>
                </div>
            </div>`;
        return;
    }

    let rowsHTML = '';
    [...sports].sort().forEach(sport => {
        const m = meta[sport] || {};
        rowsHTML += `
            <div class="sport-rule-row">
                <span class="sport-rule-name">${escapeHtml(sport)}</span>
                <div class="sport-rule-inputs">
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Min:</span>
                        <input type="number" class="sport-rule-input" data-sport="${escapeHtml(sport)}" data-type="min" value="${m.minPlayers || ''}" placeholder="\u2014" min="1">
                    </div>
                    <div class="sport-rule-input-group">
                        <span class="sport-rule-label">Max:</span>
                        <input type="number" class="sport-rule-input" data-sport="${escapeHtml(sport)}" data-type="max" value="${m.maxPlayers || ''}" placeholder="\u221E" min="1">
                    </div>
                </div>
            </div>`;
    });

    container.innerHTML = `
        <div class="sport-rules-card">
            <div class="sport-rules-header" id="rules-sport-toggle">
                <div class="sport-rules-title">Sports Rules</div>
                <span id="rules-sport-caret" style="transform:rotate(0deg); transition:transform 0.2s; color:#6B7280;">
                    <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div id="rules-sport-body" style="display:none; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB;">
                <div class="sport-rules-hint"><strong>How this works:</strong> Set min/max players per sport. The scheduler matches bunks by size.</div>
                <div id="rules-sport-list">${rowsHTML}</div>
                <div style="margin-top:20px; text-align:right;">
                    <button id="rules-sport-save" style="background:#147D91; color:white; border:none; padding:8px 24px; border-radius:999px; cursor:pointer; font-weight:600; font-size:0.9rem;">Save Rules</button>
                </div>
            </div>
        </div>`;

    const toggle = document.getElementById('rules-sport-toggle');
    toggle.onclick = () => {
        const body = document.getElementById('rules-sport-body');
        const caret = document.getElementById('rules-sport-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.style.transform = hidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };

    function collect() {
        const updated = { ...(loadSettings().app1 && loadSettings().app1.sportMetaData || {}) };
        container.querySelectorAll('.sport-rule-input').forEach(inp => {
            const sp = inp.dataset.sport;
            const type = inp.dataset.type;
            const v = parseInt(inp.value) || null;
            if (!updated[sp]) updated[sp] = {};
            if (type === 'min') updated[sp].minPlayers = v;
            else if (type === 'max') updated[sp].maxPlayers = v;
        });
        return updated;
    }

    container.querySelectorAll('.sport-rule-input').forEach(inp => {
        inp.addEventListener('change', () => {
            const updated = collect();
            const s2 = loadSettings();
            const app1b = s2.app1 || {};
            app1b.sportMetaData = updated;
            saveKey('app1', app1b);
        });
    });

    const saveBtn = document.getElementById('rules-sport-save');
    if (saveBtn) {
        saveBtn.onclick = (e) => {
            e.stopPropagation();
            const updated = collect();
            const s2 = loadSettings();
            const app1b = s2.app1 || {};
            app1b.sportMetaData = updated;
            saveKey('app1', app1b);
            saveBtn.textContent = '\u2713 Saved!';
            saveBtn.style.background = '#0F6A7A';
            setTimeout(() => { saveBtn.textContent = 'Save Rules'; saveBtn.style.background = '#147D91'; }, 1500);
        };
    }
}

// ──────────────────────────────────────────────────────────────────────────
// FIELD QUALITY GROUPS CARD
// ──────────────────────────────────────────────────────────────────────────
function getExistingFieldGroups() {
    const s = loadSettings();
    const fields = (s.app1 && s.app1.fields) || [];
    const groups = new Map();
    for (const f of fields) {
        if (f.fieldGroup) {
            if (!groups.has(f.fieldGroup)) groups.set(f.fieldGroup, []);
            groups.get(f.fieldGroup).push({ name: f.name, qualityRank: f.qualityRank || 0 });
        }
    }
    for (const [, members] of groups) {
        members.sort((a, b) => (a.qualityRank || 999) - (b.qualityRank || 999));
    }
    return groups;
}

function renderFieldQualityCard(container) {
    if (!container) return;
    const groups = getExistingFieldGroups();
    const groupNames = [...groups.keys()];
    const groupCount = groupNames.length;

    container.innerHTML = `
        <div class="sport-rules-card">
            <div class="sport-rules-header" id="rules-fq-toggle">
                <div class="sport-rules-title">Field Quality Groups${groupCount > 0
                    ? ` <span class="sport-rules-badge">${groupCount} group${groupCount !== 1 ? 's' : ''}</span>`
                    : ''}</div>
                <span id="rules-fq-caret" style="transform:rotate(0deg); transition:transform 0.2s; color:#6B7280;">
                    <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div id="rules-fq-body" style="display:none; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB;">
                <div class="sport-rules-hint"><strong>How this works:</strong> Group related fields and rank by quality. The scheduler gives the best field to the most senior grade.</div>
                <div id="rules-fq-list"></div>
            </div>
        </div>`;

    document.getElementById('rules-fq-toggle').onclick = () => {
        const body = document.getElementById('rules-fq-body');
        const caret = document.getElementById('rules-fq-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.style.transform = hidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };

    renderFieldGroupsList(document.getElementById('rules-fq-list'));
}

function renderFieldGroupsList(listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const groups = getExistingFieldGroups();
    const groupNames = [...groups.keys()];
    if (groupNames.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:#9CA3AF; font-size:0.9rem;">No field groups yet. Assign a Field Group to a facility in the Facilities tab.</div>';
        return;
    }
    groupNames.forEach(groupName => {
        const members = groups.get(groupName);
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:12px; background:#fff;';
        card.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-weight:600; font-size:0.95rem;">${escapeHtml(groupName)}</span>
                <span style="font-size:0.75rem; color:#6B7280; background:#F3F4F6; padding:2px 8px; border-radius:99px;">${members.length} field${members.length !== 1 ? 's' : ''}</span>
            </div></div>`;
        members.forEach((m, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 12px; background:#F9FAFB; border-radius:8px; border:1px solid #F3F4F6; margin-bottom:4px;';
            row.innerHTML = `<div style="width:26px; height:26px; line-height:26px; text-align:center; border-radius:50%; font-weight:700; font-size:0.8rem; background:${idx === 0 ? '#DCFCE7' : '#F3F4F6'}; color:${idx === 0 ? '#166534' : '#6B7280'};">${m.qualityRank || (idx + 1)}</div>
                <span style="flex:1; font-size:0.88rem; font-weight:500;">${escapeHtml(m.name)}</span>
                <span style="font-size:0.75rem; color:#9CA3AF;">${idx === 0 ? 'Best' : idx === members.length - 1 ? 'Lowest' : ''}</span>`;
            card.appendChild(row);
        });
        listEl.appendChild(card);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// COOLDOWN RULES CARD
// ──────────────────────────────────────────────────────────────────────────
function descriptorOptions() {
    // Returns groups used to populate the "kind + value" picker
    const sports = getSportNames();
    const specials = getSpecialActivityNames();
    const facilities = getFacilityNames();
    return { sports, specials, facilities };
}

function descriptorPickerHTML(id, currentDesc, label) {
    const opts = descriptorOptions();
    const cur = currentDesc || { kind: 'any', value: '' };
    const typeSel = ACTIVITY_TYPE_OPTIONS.map(o =>
        `<option value="type:${escapeHtml(o.value)}"${cur.kind === 'type' && cur.value === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    const sportSel = opts.sports.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>Activity: ${escapeHtml(n)}</option>`).join('');
    const specialSel = opts.specials.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>Activity: ${escapeHtml(n)}</option>`).join('');
    const facSel = opts.facilities.map(n =>
        `<option value="facility:${escapeHtml(n)}"${cur.kind === 'facility' && cur.value === n ? ' selected' : ''}>Facility: ${escapeHtml(n)}</option>`).join('');
    return `
        <label style="font-size:0.75rem; color:#6B7280; display:block; margin-bottom:2px;">${escapeHtml(label)}</label>
        <select class="rules-cd-desc" id="${id}" style="padding:6px 10px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.88rem; outline:none; background:white; min-width:170px;">
            <optgroup label="Category">${typeSel}</optgroup>
            ${sportSel ? `<optgroup label="Sports">${sportSel}</optgroup>` : ''}
            ${specialSel ? `<optgroup label="Specials / Pinned">${specialSel}</optgroup>` : ''}
            ${facSel ? `<optgroup label="Facilities">${facSel}</optgroup>` : ''}
        </select>`;
}

function parseDescValue(raw) {
    if (!raw) return { kind: 'any', value: '' };
    const idx = raw.indexOf(':');
    if (idx < 0) return { kind: 'any', value: '' };
    return { kind: raw.slice(0, idx), value: raw.slice(idx + 1) };
}

function renderCooldownCard(container) {
    if (!container) return;
    const rules = getCooldownRules();
    const count = rules.length;
    container.innerHTML = `
        <div class="sport-rules-card" style="width:100%;">
            <div class="sport-rules-header" id="rules-cd-toggle">
                <div class="sport-rules-title">Activity &amp; Facility Cooldowns${count > 0
                    ? ` <span class="sport-rules-badge">${count} rule${count !== 1 ? 's' : ''}</span>`
                    : ''}</div>
                <span id="rules-cd-caret" style="transform:rotate(0deg); transition:transform 0.2s; color:#6B7280;">
                    <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div id="rules-cd-body" style="display:block; margin-top:16px; padding-top:16px; border-top:1px solid #E5E7EB;">
                <div class="sport-rules-hint">
                    <strong>How this works:</strong> Tell the scheduler to keep certain activities or facilities away from others.
                    For example: "Don't schedule <em>Swim</em> within <em>20 min</em> <em>before</em> <em>Lunch</em>", or
                    "Don't schedule <em>Basketball</em> within <em>0 min</em> <em>after</em> <em>Painting</em>" (no back-to-back).
                    Mark a rule <em>Auto-builder only</em> to allow manual overrides.
                </div>
                <div id="rules-cd-list" style="margin-top:12px;"></div>
                <div style="margin-top:16px; display:flex; justify-content:flex-end;">
                    <button id="rules-cd-add" style="background:#111; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:0.85rem; cursor:pointer; font-weight:500;">+ Add Rule</button>
                </div>
            </div>
        </div>`;

    document.getElementById('rules-cd-toggle').onclick = () => {
        const body = document.getElementById('rules-cd-body');
        const caret = document.getElementById('rules-cd-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.style.transform = hidden ? 'rotate(180deg)' : 'rotate(0deg)';
    };

    document.getElementById('rules-cd-add').onclick = () => {
        const current = getCooldownRules();
        current.push({
            id: uid('cd_'),
            name: '',
            target:    { kind: 'type', value: 'sport' },
            reference: { kind: 'type', value: 'lunch' },
            timing: 'both',
            minutes: 20,
            autoOnly: false
        });
        saveCooldownRules(current);
        renderCooldownList();
    };

    renderCooldownList();
}

function renderCooldownList() {
    const listEl = document.getElementById('rules-cd-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const rules = getCooldownRules();
    if (rules.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:#9CA3AF; font-size:0.9rem;">No cooldown rules yet. Click "+ Add Rule" to create one.</div>';
        return;
    }

    rules.forEach((rule, idx) => {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid #E5E7EB; border-radius:12px; padding:14px 16px; margin-bottom:10px; background:#fff;';
        card.innerHTML = `
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:10px;">
                <span style="font-size:0.88rem; font-weight:600; color:#111;">Don't schedule</span>
                <div>${descriptorPickerHTML('cd-target-' + idx, rule.target, 'Target')}</div>
                <span style="font-size:0.88rem; color:#374151;">within</span>
                <input type="number" id="cd-min-${idx}" value="${parseInt(rule.minutes) || 0}" min="0" max="480" step="5"
                    style="width:70px; padding:6px 8px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.88rem; outline:none;">
                <span style="font-size:0.88rem; color:#374151;">min</span>
                <select id="cd-timing-${idx}" style="padding:6px 10px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.88rem; outline:none; background:white;">
                    <option value="before" ${rule.timing === 'before' ? 'selected' : ''}>before</option>
                    <option value="after" ${rule.timing === 'after' ? 'selected' : ''}>after</option>
                    <option value="both" ${rule.timing === 'both' || !rule.timing ? 'selected' : ''}>before &amp; after</option>
                </select>
                <div>${descriptorPickerHTML('cd-ref-' + idx, rule.reference, 'Reference')}</div>
                <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; color:#374151; margin-left:auto;">
                    <input type="checkbox" id="cd-auto-${idx}" ${rule.autoOnly ? 'checked' : ''}>
                    Auto-builder only
                </label>
                <button id="cd-del-${idx}" title="Delete rule" style="background:#FEE2E2; color:#991B1B; border:none; border-radius:6px; padding:6px 10px; font-size:0.8rem; cursor:pointer;">Delete</button>
            </div>`;
        listEl.appendChild(card);

        const tgtEl = document.getElementById('cd-target-' + idx);
        const refEl = document.getElementById('cd-ref-' + idx);
        const minEl = document.getElementById('cd-min-' + idx);
        const timEl = document.getElementById('cd-timing-' + idx);
        const autoEl = document.getElementById('cd-auto-' + idx);
        const delBtn = document.getElementById('cd-del-' + idx);

        function persist() {
            const all = getCooldownRules();
            const r = all[idx];
            if (!r) return;
            r.target    = parseDescValue(tgtEl.value);
            r.reference = parseDescValue(refEl.value);
            r.minutes   = Math.max(0, parseInt(minEl.value) || 0);
            r.timing    = timEl.value;
            r.autoOnly  = autoEl.checked;
            saveCooldownRules(all);
        }
        [tgtEl, refEl, minEl, timEl, autoEl].forEach(el => el && el.addEventListener('change', persist));
        if (delBtn) delBtn.onclick = () => {
            const all = getCooldownRules();
            all.splice(idx, 1);
            saveCooldownRules(all);
            renderCooldownList();
        };
    });
}

// ──────────────────────────────────────────────────────────────────────────
// TAB INIT
// ──────────────────────────────────────────────────────────────────────────
function initRulesTab() {
    const container = document.getElementById('rules');
    if (!container) return;
    container.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Rules</span>
              <div class="setup-card-text">
                <h3>Camp Scheduling Rules</h3>
                <p>Tell the scheduler what your camp wants &mdash; and what it never wants.</p>
              </div>
            </div>

            <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:16px;">
              <div id="rules-sport-section" style="flex:1; min-width:280px;"></div>
              <div id="rules-fq-section" style="flex:1; min-width:280px;"></div>
            </div>

            <div id="rules-cd-section" style="width:100%;"></div>
          </section>
        </div>`;

    renderSportsRulesCard(document.getElementById('rules-sport-section'));
    renderFieldQualityCard(document.getElementById('rules-fq-section'));
    renderCooldownCard(document.getElementById('rules-cd-section'));
}

// ──────────────────────────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────────────────────────
window.initRulesTab = initRulesTab;
window.renderSportsRulesCard = renderSportsRulesCard;
window.renderFieldQualityCard = renderFieldQualityCard;
window.SchedulingRules = {
    getCooldownRules: getCooldownRules,
    saveCooldownRules: saveCooldownRules,
    isCandidateAllowed: isCandidateAllowed,
    findForbiddenRanges: findForbiddenRanges,
    blockMatchesDescriptor: blockMatchesDescriptor,
    getExistingFieldGroups: getExistingFieldGroups
};

console.log('[RULES] rules.js v1.0 ready');
})();
