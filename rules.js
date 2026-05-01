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

// Pending group names created in UI but not yet backed by any field data
var _pendingFQGroups = [];

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
    return [...names].sort();
}
function getGeneralActivityNames() {
    const s = loadSettings();
    const facs = s.facilities || [];
    const names = new Set();
    facs.forEach(fac => {
        if (Array.isArray(fac.generalActivities)) {
            fac.generalActivities.forEach(ga => { if (ga && ga.name) names.add(ga.name); });
        }
    });
    // Also include pinnedTileDefaults keys (Lunch, Snacks, Dismissal, etc.)
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
// opts      : { mode: 'auto' | 'manual' }  — filters rules by their `mode` field
function isCandidateAllowed(candidate, template, opts) {
    const mode = (opts && opts.mode) || 'auto';
    const rules = getCooldownRules();
    if (!rules.length || !candidate) return true;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.target || !r.reference) continue;
        const rMode = r.mode || 'both';
        if (rMode !== 'both' && rMode !== mode) continue;
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

function findForbiddenRanges(targetDescriptor, template, opts) {
    const mode = (opts && opts.mode) || 'auto';
    const out = [];
    const rules = getCooldownRules();
    if (!rules.length) return out;
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.target || !r.reference) continue;
        const rMode = r.mode || 'both';
        if (rMode !== 'both' && rMode !== mode) continue;
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

// Best-effort classify an activity name into a "type" bucket the rules engine
// understands. Used when building a candidate from a manual edit.
function inferTypeFromActivity(name) {
    const a = String(name || '').toLowerCase().trim();
    if (!a) return 'activity';
    if (a === 'lunch') return 'lunch';
    if (a === 'snack' || a === 'snacks') return 'snacks';
    if (a === 'swim') return 'swim';
    if (a === 'dismissal') return 'dismissal';
    if (a === 'arrival') return 'arrival';
    if (a === 'league') return 'league';
    const sports = getSportNames().map(s => s.toLowerCase());
    if (sports.indexOf(a) >= 0) return 'sport';
    const specials = getSpecialActivityNames().map(s => s.toLowerCase());
    if (specials.indexOf(a) >= 0) return 'special';
    return 'activity';
}

// Build a minimal block template from window.scheduleAssignments[bunk] for
// cooldown checks during manual edits. `excludeIdx` are slot indices being
// overwritten by the candidate (so the rule doesn't compare against itself).
function buildTemplateFromBunkSlots(bunk, excludeIdx) {
    const slots = (window.scheduleAssignments && window.scheduleAssignments[bunk]) || [];
    const times = window.unifiedTimes || [];
    const excl = new Set(Array.isArray(excludeIdx) ? excludeIdx : []);
    const blocks = [];
    let current = null;
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const t = times[i];
        if (excl.has(i) || !s || !s._activity || !t) { current = null; continue; }
        const act = s._activity;
        const loc = s._location || s.location || s.field || null;
        const startMin = (typeof t.startMin === 'number') ? t.startMin
                       : (typeof t.start === 'number') ? t.start : null;
        const endMin = (typeof t.endMin === 'number') ? t.endMin
                     : (typeof t.end === 'number') ? t.end : null;
        if (startMin == null || endMin == null) { current = null; continue; }
        if (current && current.event === act && current.endMin === startMin && current.field === loc) {
            current.endMin = endMin;
        } else {
            current = { startMin, endMin, type: inferTypeFromActivity(act), event: act, field: loc };
            blocks.push(current);
        }
    }
    return blocks;
}

function describeRule(rule) {
    if (!rule) return '';
    const descName = (d) => d ? (d.kind === 'any' ? 'anything' : (d.value || d.kind)) : '';
    const t = descName(rule.target);
    const r = descName(rule.reference);
    const timing = rule.timing === 'before' ? 'before' : rule.timing === 'after' ? 'after' : 'before or after';
    return `Don't place "${t}" within ${rule.minutes || 0} min ${timing} "${r}"`;
}

// Check a candidate against manual-mode rules; return { allowed, violated: [rules] }
function checkCandidateDetailed(candidate, template, opts) {
    const mode = (opts && opts.mode) || 'auto';
    const rules = getCooldownRules();
    const violated = [];
    if (!rules.length || !candidate) return { allowed: true, violated };
    template = template || [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r.target || !r.reference) continue;
        const rMode = r.mode || 'both';
        if (rMode !== 'both' && rMode !== mode) continue;
        if (!blockMatchesDescriptor(candidate, r.target)) continue;
        const minutes = Math.max(0, parseInt(r.minutes) || 0);
        if (minutes === 0) continue;
        let hit = false;
        for (let j = 0; j < template.length; j++) {
            const w = template[j];
            if (!w || w === candidate) continue;
            if (!blockMatchesDescriptor(w, r.reference)) continue;
            const gapBefore = (w.startMin || 0) - (candidate.endMin || 0);
            const gapAfter  = (candidate.startMin || 0) - (w.endMin || 0);
            const timing = r.timing || 'both';
            if ((timing === 'before' || timing === 'both') && gapBefore >= 0 && gapBefore < minutes) { hit = true; break; }
            if ((timing === 'after'  || timing === 'both') && gapAfter  >= 0 && gapAfter  < minutes) { hit = true; break; }
        }
        if (hit) violated.push(r);
    }
    return { allowed: violated.length === 0, violated };
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
            display: grid; grid-template-columns: auto 1.2fr auto 1.2fr; gap: 14px;
            align-items: end;
        }
        .cd-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .cd-col .rules-select { width: 100%; }
        .cd-col-mode .rules-select { min-width: 130px; }
        .cd-middle {
            display: flex; align-items: center; gap: 8px; padding-bottom: 2px;
            flex-wrap: wrap;
        }
        .cd-middle .rules-select { padding: 7px 10px; font-size: 0.86rem; }
        .cd-delete-wrap { padding-top: 22px; }
        @media (max-width: 900px) {
            .cd-fields { grid-template-columns: 1fr 1fr; }
        }
        @media (max-width: 560px) {
            .cd-fields { grid-template-columns: 1fr; }
        }

        /* Sports rules rows */
        .sr-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 10px;
        }
        .sr-row {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 12px; background: #F8FAFC; border: 1px solid #E2E8F0;
            border-radius: 10px; min-width: 0;
        }
        .sr-name {
            flex: 1 1 auto; min-width: 0; font-weight: 600; color: #0F172A;
            font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .sr-inputs { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
        .sr-inputs .rules-input-num {
            width: 52px; padding: 6px 6px; font-size: 0.85rem; text-align: center;
        }
        .sr-label { font-size: 0.7rem; color: #64748B; font-weight: 600; }

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
            display: flex; align-items: center; gap: 8px; padding: 6px 10px;
            background: #F8FAFC; border-radius: 8px; border: 1px solid #F1F5F9;
            margin-bottom: 4px; cursor: grab; user-select: none;
        }
        .fq-member.fq-dragging { opacity: 0.4; }
        .fq-member.fq-drag-over { border: 2px solid #0F6A7A; background: #E6F4F7; }
        .fq-drag-handle {
            font-size: 1.1rem; color: #94A3B8; cursor: grab; padding: 0 2px; line-height: 1;
        }
        .fq-rank-badge {
            min-width: 22px; height: 22px; border-radius: 50%; background: #0F6A7A;
            color: #fff; font-size: 0.72rem; font-weight: 700;
            display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .fq-member-name { flex: 1; font-size: 0.88rem; font-weight: 500; color: #0F172A; }
        .fq-name-input { font-weight: 700; font-size: 0.93rem; }
        .fq-add-section { margin-top: 10px; border-top: 1px solid #F1F5F9; padding-top: 10px; }
        .fq-add-section-label { font-size: 0.75rem; font-weight: 600; color: #64748B; margin-bottom: 6px; }
        .fq-fields-grid {
            display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px;
            overflow-y: auto; margin-bottom: 8px; padding: 4px;
        }
        .fq-check-label {
            display: flex; align-items: center; gap: 5px; font-size: 0.82rem;
            background: #F1F5F9; border-radius: 6px; padding: 4px 10px;
            cursor: pointer; border: 1px solid #E2E8F0; white-space: nowrap;
        }
        .fq-check-label:has(input:checked) { background: #DBEAFE; border-color: #93C5FD; }
        .fq-check-label input { cursor: pointer; accent-color: #0F6A7A; }
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
function getAllFieldNamesForGroups() {
    const s = loadSettings();
    return ((s.app1 && s.app1.fields) || []).map(f => f.name).filter(Boolean).sort();
}

function applyFieldGroupUpdates(updates) {
    // updates: [{ fieldName, fieldGroup: string|null, qualityRank: number|null }]
    // Mutate in-place to preserve the reference held by facilities.js UI closures.
    const s = loadSettings();
    const app1 = s.app1 || {};
    const fields = app1.fields || [];
    updates.forEach(u => {
        const f = fields.find(f => f.name === u.fieldName);
        if (!f) return;
        if (u.fieldGroup == null) {
            delete f.fieldGroup;
            delete f.qualityRank;
        } else {
            f.fieldGroup = u.fieldGroup;
            f.qualityRank = u.qualityRank;
        }
    });
    saveKey('app1', app1);
    saveKey('fields', fields); // keep root fields key in sync so getGlobalFields() sees the change
}

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
    const savedCount = groups.size;
    const pendingExtra = _pendingFQGroups.filter(n => !groups.has(n)).length;
    const groupCount = savedCount + pendingExtra;

    container.innerHTML = `
        <div class="rules-card">
            <div class="rules-card-header" id="rules-fq-toggle">
                <div>
                    <div class="rules-card-title">
                        Field Quality Groups
                        ${groupCount ? `<span class="rules-badge">${groupCount} group${groupCount !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                    <div class="rules-card-subtitle">Group related fields and rank them. Rank 1 = best. Senior grades are matched to higher-ranked fields automatically.</div>
                </div>
                <span class="rules-caret" id="rules-fq-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-fq-body" style="display:none;">
                <div id="rules-fq-list"></div>
                <div style="margin-top:12px; display:flex; justify-content:flex-end;">
                    <button class="rules-btn-dark" id="rules-fq-add">+ Add Group</button>
                </div>
            </div>
        </div>`;

    document.getElementById('rules-fq-toggle').onclick = () => {
        const body = document.getElementById('rules-fq-body');
        const caret = document.getElementById('rules-fq-caret');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        caret.classList.toggle('open', hidden);
    };

    document.getElementById('rules-fq-add').onclick = () => {
        const existing = getExistingFieldGroups();
        let name = 'New Group';
        let n = 1;
        while (existing.has(name) || _pendingFQGroups.includes(name)) { name = `New Group ${++n}`; }
        _pendingFQGroups.push(name);
        renderFieldGroupsList(document.getElementById('rules-fq-list'));
    };

    renderFieldGroupsList(document.getElementById('rules-fq-list'));
}

function renderFieldGroupsList(listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const groups = getExistingFieldGroups();
    const allGroupNames = [...groups.keys()];
    _pendingFQGroups.forEach(n => { if (!groups.has(n)) allGroupNames.push(n); });

    if (allGroupNames.length === 0) {
        listEl.innerHTML = '<div class="rules-empty">No field quality groups yet. Click <strong>+ Add Group</strong> to create one.</div>';
        return;
    }

    const allFieldNames = getAllFieldNamesForGroups();

    allGroupNames.forEach(groupName => {
        const members = groups.get(groupName) || [];
        const memberNames = new Set(members.map(m => m.name));
        const availFields = allFieldNames.filter(f => !memberNames.has(f));

        const card = document.createElement('div');
        card.className = 'fq-group';

        card.innerHTML = `
            <div class="fq-group-head">
                <input type="text" class="rules-input fq-name-input" value="${escapeHtml(groupName)}" placeholder="Group name" style="flex:1;">
                <button class="rules-btn-ghost-danger fq-del-group">Delete Group</button>
            </div>
            <div class="fq-members-list">
                ${members.length === 0 ? '<div class="fq-empty-hint rules-empty" style="padding:6px 0 4px; font-size:0.8rem;">No fields yet — add fields below.</div>' : ''}
            </div>
            ${availFields.length > 0 ? `
            <div class="fq-add-section">
                <div class="fq-add-section-label">Add fields to this group:</div>
                <div class="fq-fields-grid">
                    ${availFields.map(f => `
                        <label class="fq-check-label">
                            <input type="checkbox" class="fq-field-check" value="${escapeHtml(f)}">
                            <span>${escapeHtml(f)}</span>
                        </label>`).join('')}
                </div>
                <button class="rules-btn-dark fq-add-field" style="font-size:0.82rem; padding:5px 14px;">+ Add Selected</button>
            </div>` : `<div style="font-size:0.8rem; color:#64748B; margin-top:6px;">All available fields are in this group.</div>`}`;

        const membersList = card.querySelector('.fq-members-list');

        // Drag state scoped to this group
        let _dragSrc = null;

        members.forEach((m, mi) => {
            const row = document.createElement('div');
            row.className = 'fq-member';
            row.draggable = true;
            row.dataset.fieldName = m.name;
            row.innerHTML = `
                <span class="fq-drag-handle" title="Drag to reorder">⠿</span>
                <span class="fq-rank-badge">${mi + 1}</span>
                <span class="fq-member-name">${escapeHtml(m.name)}</span>
                <button class="rules-btn-ghost-danger fq-rem-member" style="font-size:0.75rem; padding:3px 8px;">✕</button>`;

            // Drag-and-drop handlers
            row.addEventListener('dragstart', e => {
                _dragSrc = row;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => row.classList.add('fq-dragging'), 0);
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('fq-dragging');
                membersList.querySelectorAll('.fq-member').forEach(r => r.classList.remove('fq-drag-over'));
                _dragSrc = null;
            });
            row.addEventListener('dragover', e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (_dragSrc && _dragSrc !== row) {
                    membersList.querySelectorAll('.fq-member').forEach(r => r.classList.remove('fq-drag-over'));
                    row.classList.add('fq-drag-over');
                }
            });
            row.addEventListener('drop', e => {
                e.preventDefault();
                if (!_dragSrc || _dragSrc === row) return;
                row.classList.remove('fq-drag-over');

                // Re-insert before or after based on vertical position
                const rect = row.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    membersList.insertBefore(_dragSrc, row);
                } else {
                    membersList.insertBefore(_dragSrc, row.nextSibling);
                }

                // Reassign ranks from new DOM order and save
                const newOrder = [...membersList.querySelectorAll('.fq-member')];
                const updates = newOrder.map((r, i) => ({
                    fieldName: r.dataset.fieldName,
                    fieldGroup: groupName,
                    qualityRank: i + 1
                }));
                applyFieldGroupUpdates(updates);

                // Update rank badges in-place (no full re-render needed)
                newOrder.forEach((r, i) => {
                    const badge = r.querySelector('.fq-rank-badge');
                    if (badge) badge.textContent = i + 1;
                });
            });

            row.querySelector('.fq-rem-member').addEventListener('click', () => {
                applyFieldGroupUpdates([{ fieldName: m.name, fieldGroup: null, qualityRank: null }]);
                renderFieldGroupsList(listEl);
            });

            membersList.appendChild(row);
        });

        // Rename group
        card.querySelector('.fq-name-input').addEventListener('change', e => {
            const newName = e.target.value.trim();
            if (!newName || newName === groupName) return;
            const updates = members.map(m => ({ fieldName: m.name, fieldGroup: newName, qualityRank: m.qualityRank }));
            if (updates.length > 0) applyFieldGroupUpdates(updates);
            const pi = _pendingFQGroups.indexOf(groupName);
            if (pi !== -1) _pendingFQGroups[pi] = newName;
            renderFieldGroupsList(listEl);
        });

        // Delete group
        card.querySelector('.fq-del-group').addEventListener('click', () => {
            applyFieldGroupUpdates(members.map(m => ({ fieldName: m.name, fieldGroup: null, qualityRank: null })));
            const pi = _pendingFQGroups.indexOf(groupName);
            if (pi !== -1) _pendingFQGroups.splice(pi, 1);
            renderFieldGroupsList(listEl);
        });

        // Add selected fields — multi-select, panel stays open
        const addBtn = card.querySelector('.fq-add-field');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const checked = [...card.querySelectorAll('.fq-field-check:checked')].map(c => c.value);
                if (!checked.length) return;
                let nextRank = members.length + 1;
                const updates = checked.map(fname => ({ fieldName: fname, fieldGroup: groupName, qualityRank: nextRank++ }));
                applyFieldGroupUpdates(updates);
                const pi = _pendingFQGroups.indexOf(groupName);
                if (pi !== -1) _pendingFQGroups.splice(pi, 1);
                renderFieldGroupsList(listEl);
            });
        }

        listEl.appendChild(card);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// COOLDOWN RULES CARD
// ──────────────────────────────────────────────────────────────────────────
function descriptorPickerHTML(id, currentDesc, allowTypes) {
    const sports = getSportNames();
    const specials = getSpecialActivityNames();
    const generals = getGeneralActivityNames();
    const facilities = getFacilityNames();
    const cur = currentDesc || (allowTypes ? { kind: 'type', value: 'sport' } : { kind: 'activity', value: '' });

    const typeSel = ACTIVITY_TYPE_OPTIONS.map(o =>
        `<option value="type:${escapeHtml(o.value)}"${cur.kind === 'type' && cur.value === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    const sportSel = sports.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const specialSel = specials.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const generalSel = generals.map(n =>
        `<option value="activity:${escapeHtml(n)}"${cur.kind === 'activity' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const facSel = facilities.map(n =>
        `<option value="facility:${escapeHtml(n)}"${cur.kind === 'facility' && cur.value === n ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');

    return `<select class="rules-select" id="${id}">
            ${allowTypes ? `<optgroup label="Category">${typeSel}</optgroup>` : ''}
            ${sportSel ? `<optgroup label="Sport">${sportSel}</optgroup>` : ''}
            ${specialSel ? `<optgroup label="Special Activity">${specialSel}</optgroup>` : ''}
            ${generalSel ? `<optgroup label="General Activity">${generalSel}</optgroup>` : ''}
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
    // Auto-expand when rules exist so returning to the tab doesn't hide saved rules
    const startOpen = count > 0;
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
                <span class="rules-caret${startOpen ? ' open' : ''}" id="rules-cd-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-cd-body" style="display:${startOpen ? 'block' : 'none'};">
                <div class="rules-helper">
                    Keep certain activities or facilities apart in time. Rules apply in <strong>both auto and manual mode</strong> automatically.
                    Example: "Don't place <em>Basketball</em> within <em>20 min</em> <em>after</em> <em>Lunch</em>", or
                    "Don't place <em>Gym</em> within <em>0 min</em> <em>after</em> <em>Archery</em>" to forbid back-to-back.
                    In auto mode rules are hard constraints; in manual mode they show a warning you can override.
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
        // Default mode:auto so that the type-based target/reference dropdowns
        // (Any Sport, Lunch, etc.) are visible immediately after adding the rule.
        current.push({
            id: uid('cd_'),
            mode: 'auto',
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
        const mode = rule.mode || 'both';
        const allowTypes = (mode === 'auto');
        const card = document.createElement('div');
        card.className = 'cd-row';
        card.innerHTML = `
            <div class="cd-fields">
                <div class="cd-col cd-col-mode">
                    <span class="rules-sub-title">Applies in</span>
                    <select class="rules-select" id="cd-mode-${idx}">
                        <option value="auto"   ${mode === 'auto'   ? 'selected' : ''}>Auto Builder</option>
                        <option value="manual" ${mode === 'manual' ? 'selected' : ''}>Manual Mode</option>
                        <option value="both"   ${mode === 'both'   ? 'selected' : ''}>Both</option>
                    </select>
                </div>
                <div class="cd-col">
                    <span class="rules-sub-title">Don't place</span>
                    ${descriptorPickerHTML('cd-target-' + idx, rule.target, allowTypes)}
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
                    ${descriptorPickerHTML('cd-ref-' + idx, rule.reference, allowTypes)}
                </div>
            </div>
            <div class="cd-delete-wrap">
                <button class="rules-btn-ghost-danger" id="cd-del-${idx}" title="Remove this rule">Remove</button>
            </div>`;
        listEl.appendChild(card);

        const modeEl = document.getElementById('cd-mode-' + idx);
        const tgtEl  = document.getElementById('cd-target-' + idx);
        const refEl  = document.getElementById('cd-ref-' + idx);
        const minEl  = document.getElementById('cd-min-' + idx);
        const timEl  = document.getElementById('cd-timing-' + idx);
        const delBtn = document.getElementById('cd-del-' + idx);

        function persist() {
            const all = getCooldownRules();
            const r = all[idx];
            if (!r) return;
            r.mode      = modeEl.value;
            r.target    = parseDescValue(tgtEl.value);
            r.reference = parseDescValue(refEl.value);
            r.minutes   = Math.max(0, parseInt(minEl.value) || 0);
            r.timing    = timEl.value;
            // If switching away from auto, reset any category-type descriptors to empty named item
            if (r.mode !== 'auto' && r.target && r.target.kind === 'type') {
                r.target = { kind: 'activity', value: '' };
            }
            if (r.mode !== 'auto' && r.reference && r.reference.kind === 'type') {
                r.reference = { kind: 'activity', value: '' };
            }
            saveCooldownRules(all);
        }
        if (modeEl) modeEl.addEventListener('change', () => {
            persist();
            renderCooldownList();
        });
        [tgtEl, refEl, timEl].forEach(el => el && el.addEventListener('change', persist));
        // 'input' fires on every keystroke so the value is captured even if the user
        // navigates away before the number field fires its 'change' (blur) event.
        if (minEl) { minEl.addEventListener('change', persist); minEl.addEventListener('input', persist); }
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
    checkCandidateDetailed: checkCandidateDetailed,
    findForbiddenRanges: findForbiddenRanges,
    blockMatchesDescriptor: blockMatchesDescriptor,
    getExistingFieldGroups: getExistingFieldGroups,
    applyFieldGroupUpdates: applyFieldGroupUpdates,
    inferTypeFromActivity: inferTypeFromActivity,
    buildTemplateFromBunkSlots: buildTemplateFromBunkSlots,
    describeRule: describeRule
};

console.log('[RULES] rules.js v1.1 ready');
})();
