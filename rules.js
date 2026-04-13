// ============================================================================
// rules.js — CAMP SCHEDULING RULES v1.1
// ============================================================================
// Houses all cross-cutting scheduling "rules" that camps want the scheduler
// to respect. Sections:
//   1. Sports Rules (min/max players per sport)   — moved from facilities.js
//   2. Field Quality Groups                        — moved from facilities.js
//   3. Cooldown / Spacing Rules (new)             — keep X away from Y
//
// NOTE: Cooldown rules apply ONLY to the auto-builder. In manual mode the
// user decides placement, so a "don't place sport after lunch" rule would
// just be arguing with the user. We tell the auto-builder; we don't fight
// manual drags.
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

console.log('[RULES] rules.js v1.1 loading...');

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
    { value: 'sport',     label: 'Any Sport' },
    { value: 'swim',      label: 'Swim' },
    { value: 'lunch',     label: 'Lunch' },
    { value: 'snack',     label: 'Snack' },
    { value: 'special',   label: 'Any Special' },
    { value: 'custom',    label: 'Any Custom' },
    { value: 'league',    label: 'League' },
    { value: 'dismissal', label: 'Dismissal' },
    { value: 'arrival',   label: 'Arrival' }
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
// opts      : reserved (auto flag still accepted but cooldowns always apply)
function isCandidateAllowed(candidate, template, _opts) {
    const rules = getCooldownRules();
    if (!rules.length || !candidate) return true;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.target || !r.reference) continue;
        if (!blockMatchesDescriptor(candidate, r.target)) continue;
        const minutes = Math.max(0, parseInt(r.minutes) || 0);
        if (minutes === 0) continue;
        for (let j = 0; j < template.length; j++) {
            const w = template[j];
            if (!w || w === candidate) continue;
            if (!blockMatchesDescriptor(w, r.reference)) continue;
            const gapBefore = (w.startMin || 0) - (candidate.endMin || 0);
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

function findForbiddenRanges(targetDescriptor, template, _opts) {
    const out = [];
    const rules = getCooldownRules();
    if (!rules.length) return out;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.target || !r.reference) continue;
        if (!descriptorCanMatch(r.target, targetDescriptor)) continue;
        const minutes = Math.max(0, parseInt(r.minutes) || 0);
        if (minutes === 0) continue;
        for (let j = 0; j < template.length; j++) {
            const w = template[j];
            if (!blockMatchesDescriptor(w, r.reference)) continue;
            const timing = r.timing || 'both';
            if (timing === 'after' || timing === 'both') {
                out.push({ start: w.endMin, end: w.endMin + minutes, side: 'after' });
            }
            if (timing === 'before' || timing === 'both') {
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
    return true;
}

// ──────────────────────────────────────────────────────────────────────────
// STYLES — injected once
// ──────────────────────────────────────────────────────────────────────────
function injectRulesStyles() {
    if (document.getElementById('rules-tab-styles')) return;
    const css = `
        .rules-page { max-width: 1100px; }
        .rules-card {
            background: #fff; border: 1px solid #E5E7EB; border-radius: 14px;
            padding: 18px 20px; margin-bottom: 16px;
            box-shadow: 0 1px 2px rgba(15,23,42,0.03);
        }
        .rules-card-header {
            display: flex; align-items: center; justify-content: space-between;
            cursor: pointer; user-select: none;
        }
        .rules-card-title {
            font-size: 1.02rem; font-weight: 700; color: #0F172A;
            display: flex; align-items: center; gap: 10px;
        }
        .rules-card-title .rules-badge {
            background: #ECFEFF; color: #155E75; border: 1px solid #A5F3FC;
            font-size: 0.72rem; font-weight: 600; padding: 2px 10px; border-radius: 99px;
        }
        .rules-card-subtitle {
            font-size: 0.85rem; color: #6B7280; margin-top: 4px;
        }
        .rules-caret {
            color: #94A3B8; transition: transform 0.2s; flex-shrink: 0;
        }
        .rules-caret.open { transform: rotate(180deg); }
        .rules-card-body {
            margin-top: 16px; padding-top: 16px; border-top: 1px solid #F1F5F9;
        }
        .rules-helper {
            background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px;
            padding: 10px 14px; font-size: 0.85rem; color: #475569; line-height: 1.5;
        }
        .rules-helper strong { color: #0F172A; }
        .rules-sub-title {
            font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
            color: #64748B; margin-bottom: 4px; display: block;
        }
        .rules-select, .rules-input {
            padding: 8px 12px; border: 1px solid #E2E8F0; border-radius: 10px;
            font-size: 0.9rem; background: #fff; outline: none; color: #0F172A;
            font-family: inherit; transition: border-color 0.15s, box-shadow 0.15s;
            min-width: 0;
        }
        .rules-select:focus, .rules-input:focus {
            border-color: #147D91; box-shadow: 0 0 0 3px rgba(20,125,145,0.12);
        }
        .rules-input-num { width: 72px; text-align: center; }
        .rules-btn-primary {
            background: #147D91; color: #fff; border: none; padding: 9px 22px;
            border-radius: 999px; font-weight: 600; font-size: 0.88rem; cursor: pointer;
            transition: background 0.15s;
        }
        .rules-btn-primary:hover { background: #0F5F6E; }
        .rules-btn-dark {
            background: #111827; color: #fff; border: none; padding: 9px 18px;
            border-radius: 10px; font-weight: 600; font-size: 0.85rem; cursor: pointer;
        }
        .rules-btn-ghost-danger {
            background: transparent; color: #B91C1C; border: 1px solid #FECACA;
            padding: 7px 12px; border-radius: 8px; font-weight: 500; font-size: 0.8rem;
            cursor: pointer; transition: background 0.15s, color 0.15s;
        }
        .rules-btn-ghost-danger:hover { background: #FEF2F2; }
        .rules-empty {
            text-align: center; padding: 28px 18px; color: #94A3B8;
            font-size: 0.9rem; border: 1px dashed #E2E8F0; border-radius: 12px;
            background: #FAFAFA;
        }

        /* Cooldown row — sentence-style */
        .cd-row {
            border: 1px solid #E5E7EB; border-radius: 12px;
            background: #FAFBFC; padding: 14px 16px; margin-bottom: 10px;
            display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start;
        }
        .cd-fields {
            display: grid; grid-template-columns: 1.2fr auto 1.2fr; gap: 14px;
            align-items: end;
        }
        .cd-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .cd-col .rules-select { width: 100%; }
        .cd-arrow {
            color: #CBD5E1; font-size: 1.3rem; padding-bottom: 8px; user-select: none;
        }
        .cd-middle {
            display: flex; align-items: center; gap: 8px; padding-bottom: 2px;
            flex-wrap: wrap;
        }
        .cd-middle .rules-select { padding: 7px 10px; font-size: 0.86rem; }
        .cd-delete-wrap { padding-top: 22px; }
        @media (max-width: 780px) {
            .cd-fields { grid-template-columns: 1fr; }
            .cd-arrow { display: none; }
        }

        /* Sports rules rows */
        .sr-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
            gap: 10px;
        }
        .sr-row {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 12px; background: #F8FAFC; border: 1px solid #E2E8F0;
            border-radius: 10px;
        }
        .sr-row .sr-name { font-weight: 600; color: #0F172A; font-size: 0.88rem; }
        .sr-row .sr-inputs { display: flex; gap: 8px; align-items: center; }
        .sr-row .rules-input-num { width: 56px; padding: 6px 8px; font-size: 0.85rem; }
        .sr-label { font-size: 0.72rem; color: #64748B; font-weight: 600; }

        /* Field quality groups */
        .fq-group {
            border: 1px solid #E5E7EB; border-radius: 12px; padding: 14px 16px;
            margin-bottom: 10px; background: #fff;
        }
        .fq-group-head {
            display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
        }
        .fq-group-name { font-weight: 700; color: #0F172A; font-size: 0.95rem; }
        .fq-group-count {
            font-size: 0.72rem; color: #64748B; background: #F1F5F9;
            padding: 2px 10px; border-radius: 99px;
        }
        .fq-member {
            display: flex; align-items: center; gap: 10px; padding: 8px 12px;
            background: #F8FAFC; border-radius: 8px; border: 1px solid #F1F5F9;
            margin-bottom: 4px;
        }
        .fq-member-rank {
            width: 26px; height: 26px; line-height: 26px; text-align: center;
            border-radius: 50%; font-weight: 700; font-size: 0.78rem;
            background: #F1F5F9; color: #64748B;
        }
        .fq-member-rank.best { background: #DCFCE7; color: #166534; }
        .fq-member-name { flex: 1; font-size: 0.88rem; font-weight: 500; color: #0F172A; }
        .fq-member-label { font-size: 0.72rem; color: #94A3B8; }
    `;
    const style = document.createElement('style');
    style.id = 'rules-tab-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

// ──────────────────────────────────────────────────────────────────────────
// SPORTS RULES CARD
// ──────────────────────────────────────────────────────────────────────────
function renderSportsRulesCard(container) {
    if (!container) return;
    const s = loadSettings();
    const app1 = s.app1 || {};
    const meta = app1.sportMetaData || {};
    const sports = [...getSportNames()].sort();
    const count = sports.length;

    container.innerHTML = `
        <div class="rules-card">
            <div class="rules-card-header" id="rules-sport-toggle">
                <div>
                    <div class="rules-card-title">
                        Sports Rules
                        ${count ? `<span class="rules-badge">${count} sport${count !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div class="rules-card-subtitle">Min/max players per sport so the scheduler can match bunks by size.</div>
                </div>
                <span class="rules-caret" id="rules-sport-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-sport-body" style="display:none;">
                ${count === 0
                    ? `<div class="rules-empty">No sports configured yet. Add sports to a facility first.</div>`
                    : `<div class="sr-grid" id="rules-sport-grid"></div>
                       <div style="margin-top:16px; text-align:right;">
                         <button class="rules-btn-primary" id="rules-sport-save">Save</button>
                       </div>`
                }
            </div>
        </div>`;

    const toggle = document.getElementById('rules-sport-toggle');
    toggle.onclick = () => {
        const body = document.getElementById('rules-sport-body');
        const caret = document.getElementById('rules-sport-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.classList.toggle('open', hidden);
    };

    if (count === 0) return;

    const grid = document.getElementById('rules-sport-grid');
    sports.forEach(sport => {
        const m = meta[sport] || {};
        const row = document.createElement('div');
        row.className = 'sr-row';
        row.innerHTML = `
            <span class="sr-name">${escapeHtml(sport)}</span>
            <div class="sr-inputs">
                <span class="sr-label">Min</span>
                <input type="number" class="rules-input rules-input-num sr-in" data-sport="${escapeHtml(sport)}" data-type="min" value="${m.minPlayers || ''}" placeholder="—" min="1">
                <span class="sr-label">Max</span>
                <input type="number" class="rules-input rules-input-num sr-in" data-sport="${escapeHtml(sport)}" data-type="max" value="${m.maxPlayers || ''}" placeholder="∞" min="1">
            </div>`;
        grid.appendChild(row);
    });

    function collect() {
        const updated = { ...(((loadSettings().app1) || {}).sportMetaData || {}) };
        container.querySelectorAll('.sr-in').forEach(inp => {
            const sp = inp.dataset.sport;
            const type = inp.dataset.type;
            const v = parseInt(inp.value) || null;
            if (!updated[sp]) updated[sp] = {};
            if (type === 'min') updated[sp].minPlayers = v;
            else if (type === 'max') updated[sp].maxPlayers = v;
        });
        return updated;
    }
    function persist() {
        const updated = collect();
        const s2 = loadSettings();
        const app1b = s2.app1 || {};
        app1b.sportMetaData = updated;
        saveKey('app1', app1b);
    }
    container.querySelectorAll('.sr-in').forEach(inp => inp.addEventListener('change', persist));

    const saveBtn = document.getElementById('rules-sport-save');
    if (saveBtn) {
        saveBtn.onclick = (e) => {
            e.stopPropagation();
            persist();
            saveBtn.textContent = '\u2713 Saved';
            saveBtn.style.background = '#0F6A7A';
            setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.style.background = ''; }, 1400);
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
        <div class="rules-card">
            <div class="rules-card-header" id="rules-fq-toggle">
                <div>
                    <div class="rules-card-title">
                        Field Quality Groups
                        ${groupCount ? `<span class="rules-badge">${groupCount} group${groupCount !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div class="rules-card-subtitle">Rank related fields. The best field goes to the most senior grade.</div>
                </div>
                <span class="rules-caret" id="rules-fq-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-fq-body" style="display:none;">
                <div id="rules-fq-list"></div>
            </div>
        </div>`;

    document.getElementById('rules-fq-toggle').onclick = () => {
        const body = document.getElementById('rules-fq-body');
        const caret = document.getElementById('rules-fq-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.classList.toggle('open', hidden);
    };

    renderFieldGroupsList(document.getElementById('rules-fq-list'));
}

function renderFieldGroupsList(listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const groups = getExistingFieldGroups();
    const groupNames = [...groups.keys()];
    if (groupNames.length === 0) {
        listEl.innerHTML = '<div class="rules-empty">No field groups yet. Assign a Field Group to a facility in the Facilities tab.</div>';
        return;
    }
    groupNames.forEach(groupName => {
        const members = groups.get(groupName);
        const card = document.createElement('div');
        card.className = 'fq-group';
        card.innerHTML = `
            <div class="fq-group-head">
                <span class="fq-group-name">${escapeHtml(groupName)}</span>
                <span class="fq-group-count">${members.length} field${members.length !== 1 ? 's' : ''}</span>
            </div>`;
        members.forEach((m, idx) => {
            const row = document.createElement('div');
            row.className = 'fq-member';
            row.innerHTML = `
                <div class="fq-member-rank ${idx === 0 ? 'best' : ''}">${m.qualityRank || (idx + 1)}</div>
                <span class="fq-member-name">${escapeHtml(m.name)}</span>
                <span class="fq-member-label">${idx === 0 ? 'Best' : idx === members.length - 1 ? 'Lowest' : ''}</span>`;
            card.appendChild(row);
        });
        listEl.appendChild(card);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// COOLDOWN RULES CARD
// ──────────────────────────────────────────────────────────────────────────
function descriptorPickerHTML(id, currentDesc) {
    const sports = getSportNames();
    const specials = getSpecialActivityNames();
    const facilities = getFacilityNames();
    const cur = currentDesc || { kind: 'any', value: '' };

    const typeSel = ACTIVITY_TYPE_OPTIONS.map(o =>
        `<option value="type:${escapeHtml(o.value)}"${cur.kind === 'type' && cur.value === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    const sportSel = sports.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const specialSel = specials.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const facSel = facilities.map(n =>
        `<option value="facility:${escapeHtml(n)}"${cur.kind === 'facility' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');

    return `<select class="rules-select" id="${id}">
            <optgroup label="Category">${typeSel}</optgroup>
            ${sportSel ? `<optgroup label="Sport">${sportSel}</optgroup>` : ''}
            ${specialSel ? `<optgroup label="Special / Pinned Activity">${specialSel}</optgroup>` : ''}
            ${facSel ? `<optgroup label="Facility">${facSel}</optgroup>` : ''}
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
        <div class="rules-card">
            <div class="rules-card-header" id="rules-cd-toggle">
                <div>
                    <div class="rules-card-title">
                        Cooldowns &amp; Spacing
                        <span id="rules-cd-badge">${count ? `<span class="rules-badge">${count} rule${count !== 1 ? 's' : ''}</span>` : ''}</span>
                    </div>
                    <div class="rules-card-subtitle">Tell the auto-builder to keep certain activities or facilities apart in time.</div>
                </div>
                <span class="rules-caret" id="rules-cd-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-cd-body" style="display:none;">
                <div class="rules-helper">
                    <strong>Applies to the auto-builder only.</strong>
                    Example: "Don't place <em>Any Sport</em> within <em>20 min</em> <em>after</em> <em>Lunch</em>", or
                    "Don't place <em>Basketball</em> within <em>0 min</em> <em>after</em> <em>Painting</em>" to forbid back-to-back.
                </div>
                <div id="rules-cd-list" style="margin-top:14px;"></div>
                <div style="margin-top:12px; display:flex; justify-content:flex-end;">
                    <button class="rules-btn-dark" id="rules-cd-add">+ Add Rule</button>
                </div>
            </div>
        </div>`;

    document.getElementById('rules-cd-toggle').onclick = () => {
        const body = document.getElementById('rules-cd-body');
        const caret = document.getElementById('rules-cd-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.classList.toggle('open', hidden);
    };

    document.getElementById('rules-cd-add').onclick = () => {
        const current = getCooldownRules();
        current.push({
            id: uid('cd_'),
            target:    { kind: 'type', value: 'sport' },
            reference: { kind: 'type', value: 'lunch' },
            timing: 'after',
            minutes: 20
        });
        saveCooldownRules(current);
        renderCooldownList();
    };

    renderCooldownList();
}

function updateCooldownBadge() {
    const badgeEl = document.getElementById('rules-cd-badge');
    if (!badgeEl) return;
    const count = getCooldownRules().length;
    badgeEl.innerHTML = count
        ? `<span class="rules-badge">${count} rule${count !== 1 ? 's' : ''}</span>`
        : '';
}

function renderCooldownList() {
    const listEl = document.getElementById('rules-cd-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    updateCooldownBadge();
    const rules = getCooldownRules();
    if (rules.length === 0) {
        listEl.innerHTML = '<div class="rules-empty">No cooldown rules yet. Click <strong>+ Add Rule</strong> to create one.</div>';
        return;
    }

    rules.forEach((rule, idx) => {
        const card = document.createElement('div');
        card.className = 'cd-row';
        card.innerHTML = `
            <div class="cd-fields">
                <div class="cd-col">
                    <span class="rules-sub-title">Don't place</span>
                    ${descriptorPickerHTML('cd-target-' + idx, rule.target)}
                </div>
                <div class="cd-col cd-middle-wrap">
                    <span class="rules-sub-title">Within</span>
                    <div class="cd-middle">
                        <input type="number" class="rules-input rules-input-num" id="cd-min-${idx}"
                               value="${parseInt(rule.minutes) || 0}" min="0" max="480" step="5">
                        <span style="font-size:0.85rem; color:#475569;">min</span>
                        <select class="rules-select" id="cd-timing-${idx}">
                            <option value="before" ${rule.timing === 'before' ? 'selected' : ''}>before</option>
                            <option value="after"  ${rule.timing === 'after'  ? 'selected' : ''}>after</option>
                            <option value="both"   ${rule.timing === 'both' || !rule.timing ? 'selected' : ''}>before &amp; after</option>
                        </select>
                    </div>
                </div>
                <div class="cd-col">
                    <span class="rules-sub-title">Of</span>
                    ${descriptorPickerHTML('cd-ref-' + idx, rule.reference)}
                </div>
            </div>
            <div class="cd-delete-wrap">
                <button class="rules-btn-ghost-danger" id="cd-del-${idx}" title="Remove this rule">Remove</button>
            </div>`;
        listEl.appendChild(card);

        const tgtEl = document.getElementById('cd-target-' + idx);
        const refEl = document.getElementById('cd-ref-' + idx);
        const minEl = document.getElementById('cd-min-' + idx);
        const timEl = document.getElementById('cd-timing-' + idx);
        const delBtn = document.getElementById('cd-del-' + idx);

        function persist() {
            const all = getCooldownRules();
            const r = all[idx];
            if (!r) return;
            r.target    = parseDescValue(tgtEl.value);
            r.reference = parseDescValue(refEl.value);
            r.minutes   = Math.max(0, parseInt(minEl.value) || 0);
            r.timing    = timEl.value;
            saveCooldownRules(all);
        }
        [tgtEl, refEl, minEl, timEl].forEach(el => el && el.addEventListener('change', persist));
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
    injectRulesStyles();
    container.innerHTML = `
        <div class="setup-grid">
          <section class="setup-card setup-card-wide rules-page" style="border:none; box-shadow:none; background:transparent;">
            <div class="setup-card-header" style="margin-bottom:20px;">
              <span class="setup-step-pill">Rules</span>
              <div class="setup-card-text">
                <h3>Camp Scheduling Rules</h3>
                <p>Tell the scheduler what your camp wants &mdash; and what it never wants.</p>
              </div>
            </div>

            <div id="rules-cd-section"></div>
            <div id="rules-sport-section"></div>
            <div id="rules-fq-section"></div>
          </section>
        </div>`;

    renderCooldownCard(document.getElementById('rules-cd-section'));
    renderSportsRulesCard(document.getElementById('rules-sport-section'));
    renderFieldQualityCard(document.getElementById('rules-fq-section'));
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

console.log('[RULES] rules.js v1.1 ready');
})();
