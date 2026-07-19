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
function escapeHtml(s) { return window.CampUtils.escapeHtml(s); }  // → campistry_utils.js (canonical)
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
        if (bField === v) return true;
        // ★ Field combos: a rule on "Full Gym" matches blocks on its
        //   sub-fields too (and vice versa), because using Gym 1 / Gym 2
        //   occupies Full Gym's space and using Full Gym occupies the subs.
        //   Without this, a rule like "Full Gym must be 20min from Lunch"
        //   silently fails to block Gym 1 / Gym 2 in that window.
        if (window.FieldCombos && typeof window.FieldCombos.getExclusiveFields === 'function') {
            const partners = window.FieldCombos.getExclusiveFields(desc.value) || [];
            for (let i = 0; i < partners.length; i++) {
                if (String(partners[i]).toLowerCase().trim() === bField) return true;
            }
        }
        return false;
    }
    return false;
}

// candidate : { startMin, endMin, type, event, field, _assignedSpecial, _specialLocation }
// template  : array of blocks already placed on the bunk
// opts      : { mode: 'auto' | 'manual' }  — filters rules by their `mode` field
//
// LIMITATION (Slice 3 audit, N13): cooldowns are evaluated only against the
// `template` blocks the caller passes in. Today every caller builds `template`
// from a single day's scheduleAssignments — there is no cross-day awareness.
// A user-configured rule like "no Soccer within 12h of Soccer" is therefore
// silently a within-today rule. To support multi-day cooldowns the caller
// would need to inject yesterday's last-block-of-day (or all of yesterday's
// blocks) into `template` with appropriate negative startMin offsets, or
// this engine would need a `previousDayBlocks` opt. Documented here so the
// limitation isn't a surprise to future contributors.
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
        .rules-page { max-width: 100%; }
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

        /* Spacing rule row */
        .cd-row {
            border: 1px solid #E5E7EB; border-radius: 12px;
            background: #FAFBFC; padding: 18px 20px; margin-bottom: 12px;
            display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center;
        }
        .cd-fields {
            display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
        }
        .cd-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; min-width: 160px; }
        .cd-col .rules-select { width: 100%; }
        .cd-middle-wrap { flex: 1.5; min-width: 220px; }
        .cd-middle {
            display: flex; align-items: center; gap: 10px; padding-bottom: 2px;
            flex-wrap: wrap;
        }
        .cd-middle .rules-select { padding: 7px 10px; font-size: 0.86rem; }
        .cd-label {
            font-size: 0.88rem; font-weight: 600; color: #475569;
            white-space: nowrap; line-height: 1;
        }
        .cd-delete-wrap { padding-top: 0; display: flex; align-items: center; }

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

function getBuilderMode() {
    try {
        var gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
        return (gs.app1 && gs.app1.builderMode) || 'manual';
    } catch (_) { return 'manual'; }
}

function renderCooldownCard(container) {
    if (!container) return;
    const rules = getCooldownRules();
    const count = rules.length;
    const mode = getBuilderMode();
    const modeLabel = mode === 'auto' ? 'Auto Builder' : 'Manual Mode';
    container.innerHTML = `
        <div class="rules-card">
            <div class="rules-card-header" id="rules-cd-toggle">
                <div>
                    <div class="rules-card-title">
                        Spacing
                        <span id="rules-cd-badge">${count ? `<span class="rules-badge">${count} rule${count !== 1 ? 's' : ''}</span>` : ''}</span>
                    </div>
                    <div class="rules-card-subtitle">Keep certain activities or facilities apart in time.</div>
                </div>
                <span class="rules-caret" id="rules-cd-caret">
                    <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
                </span>
            </div>
            <div class="rules-card-body" id="rules-cd-body" style="display:none;">
                <div class="rules-helper">
                    Set spacing rules between activities. Currently in <strong>${escapeHtml(modeLabel)}</strong>.
                    ${mode === 'auto'
                        ? 'In auto mode, rules are hard constraints. You can target categories (e.g. <em>Any Sport</em>), specific activities, or facilities.'
                        : 'In manual mode, rules show a warning you can override. You can target specific activities, facilities, or general activities.'}
                    <br>Example: "<em>Basketball</em> is unavailable <em>20 min</em> <em>after</em> <em>Lunch</em>"
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
        const isAuto = getBuilderMode() === 'auto';
        current.push({
            id: uid('cd_'),
            mode: isAuto ? 'auto' : 'manual',
            target:    isAuto ? { kind: 'type', value: 'sport' } : { kind: 'activity', value: '' },
            reference: isAuto ? { kind: 'type', value: 'lunch' } : { kind: 'activity', value: '' },
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

    const isAuto = getBuilderMode() === 'auto';

    rules.forEach((rule, idx) => {
        const allowTypes = isAuto;
        const card = document.createElement('div');
        card.className = 'cd-row';
        card.innerHTML = `
            <div class="cd-fields">
                <div class="cd-col">
                    ${descriptorPickerHTML('cd-target-' + idx, rule.target, allowTypes)}
                </div>
                <div class="cd-col cd-middle-wrap">
                    <span class="cd-label">is unavailable</span>
                    <div class="cd-middle">
                        <input type="number" class="rules-input rules-input-num" id="cd-min-${idx}"
                               value="${parseInt(rule.minutes) || 0}" min="0" max="480" step="5">
                        <span class="cd-label">min</span>
                        <select class="rules-select" id="cd-timing-${idx}">
                            <option value="before" ${rule.timing === 'before' ? 'selected' : ''}>before</option>
                            <option value="after"  ${rule.timing === 'after'  ? 'selected' : ''}>after</option>
                            <option value="both"   ${rule.timing === 'both' || !rule.timing ? 'selected' : ''}>before &amp; after</option>
                        </select>
                    </div>
                </div>
                <div class="cd-col">
                    ${descriptorPickerHTML('cd-ref-' + idx, rule.reference, allowTypes)}
                </div>
            </div>
            <div class="cd-delete-wrap">
                <button class="rules-btn-ghost-danger" id="cd-del-${idx}" title="Remove this rule">Remove</button>
            </div>`;
        listEl.appendChild(card);

        const tgtEl  = document.getElementById('cd-target-' + idx);
        const refEl  = document.getElementById('cd-ref-' + idx);
        const minEl  = document.getElementById('cd-min-' + idx);
        const timEl  = document.getElementById('cd-timing-' + idx);
        const delBtn = document.getElementById('cd-del-' + idx);

        function persist() {
            const all = getCooldownRules();
            const r = all[idx];
            if (!r) return;
            r.mode      = isAuto ? 'auto' : 'manual';
            r.target    = parseDescValue(tgtEl.value);
            r.reference = parseDescValue(refEl.value);
            r.minutes   = Math.max(0, parseInt(minEl.value) || 0);
            r.timing    = timEl.value;
            saveCooldownRules(all);
        }
        [tgtEl, refEl, timEl].forEach(el => el && el.addEventListener('change', persist));
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

    // Re-render cooldown rules when builder mode changes so options update
    window.addEventListener('campistry-builder-mode-changed', () => {
        const cdSection = document.getElementById('rules-cd-section');
        if (cdSection) renderCooldownCard(cdSection);
    });
}

// ──────────────────────────────────────────────────────────────────────────
// SPACING ENFORCEMENT SWEEP — post-generation, BOTH builders
// ──────────────────────────────────────────────────────────────────────────
// The main auto path gates placement via isCandidateAllowed({mode:'auto'}), but
// coverage / recapture fill passes (e.g. phase4.9-recapture, the final free-fill
// sweeps) place activities WITHOUT that gate, and the manual builder never gated
// spacing at all. This sweep runs as the FINAL pass on the assembled per-bunk
// schedule and demotes any block that violates a spacing rule (target within N
// minutes of reference) to Free — guaranteeing 0 violations regardless of which
// placement path created them.
//
// Design:
//   • Demote the movable TARGET only; the (usually pinned) REFERENCE is left intact.
//   • DEMOTE-ONLY — never moves an activity to a new field/time, so it cannot
//     introduce a field-sharing / capacity conflict (unlike a swap-based repair).
//   • User-locked blocks (_league / _postEdit / _pinned) are never demoted; if a
//     locked block is the violating target, it's left + counted as unresolved.
//   • Times come from each entry's own _startMin/_endMin (both builders stamp
//     these), so it needs no external geometry and works identically in both.
//   • Mode-filtered: a rule applies when its mode is 'both' or matches opts.mode.
// Must run LAST (after every fill/refill pass) or a later fill can re-violate.
function enforceSpacingSweep(scheduleAssignments, opts) {
    const mode = (opts && opts.mode) || 'auto';
    const rules = getCooldownRules().filter(function (r) {
        const rm = r.mode || 'both';
        return (rm === 'both' || rm === mode) && r.target && r.reference && (parseInt(r.minutes) || 0) > 0;
    });
    const report = { mode: mode, rulesApplied: rules.length, refilled: 0, demoted: 0, unresolved: 0, details: [] };
    if (!rules.length || !scheduleAssignments) return report;

    // Time resolution mirrors the room-capacity sweep's _rtime: manual block-A entries
    // do NOT carry _startMin/_endMin (their geometry lives in _perBunkSlots / divisionTimes
    // by slot index), so reading only the entry would make this sweep BLIND to them. Resolve
    // per-bunk geometry first, then the entry's own stamp, then division-level period times.
    const _divs = (opts && opts.divisions) || window.divisions || {};
    const _b2g = {};
    Object.keys(_divs).forEach(function (g) { ((_divs[g] && _divs[g].bunks) || []).forEach(function (b) { _b2g[String(b)] = g; }); });
    const _dt = window.divisionTimes || {};
    function slotTime(bunk, idx, e) {
        // ENTRY stamp first: it is the activity's ACTUAL placement time, set by the
        // placing pass. _perBunkSlots is the render grid, but mid-gen (auto STEP 6.85)
        // it isn't settled yet — preferring it made the sweep fall through to the coarse
        // division-period time and miss a block whose entry already held the real
        // (violating) time. Geometry is the fallback for manual block-A entries that
        // carry no _startMin (their time lives only in _perBunkSlots / divisionTimes).
        if (e && e._startMin != null && e._endMin != null) return { s: e._startMin, e: e._endMin };
        const g = _b2g[String(bunk)];
        const pbs = (window._perBunkSlots && window._perBunkSlots[g] && window._perBunkSlots[g][bunk])
                 || (_dt[g] && _dt[g]._perBunkSlots && _dt[g]._perBunkSlots[bunk]);
        if (pbs && pbs[idx] && pbs[idx].startMin != null) return { s: pbs[idx].startMin, e: pbs[idx].endMin };
        const ds = _dt[g];
        if (ds && ds[idx] && ds[idx].startMin != null) return { s: ds[idx].startMin, e: ds[idx].endMin };
        return null;
    }
    function blocksOf(bunk, slots) {
        const out = [];
        for (let i = 0; i < slots.length; i++) {
            const e = slots[i];
            if (!e || e.continuation) continue;
            const act = e._activity || e.sport || e.event;
            if (!act) continue;
            const t = slotTime(bunk, i, e);
            if (!t || t.s == null || t.e == null) continue;
            let em = t.e;
            for (let k = i + 1; k < slots.length; k++) { // extend end across continuation slots
                if (slots[k] && slots[k].continuation) { const ct = slotTime(bunk, k, slots[k]); if (ct && ct.e != null) em = ct.e; }
                else break;
            }
            out.push({
                idx: i, event: act, type: inferTypeFromActivity(act),
                field: e.field || e._specialLocation || e.location || null,
                startMin: t.s, endMin: em,
                prot: !!(e._league || e._postEdit || e._pinned)
            });
        }
        return out;
    }
    function demote(slots, idx, s, e) {
        if (!slots[idx]) return false;
        slots[idx] = { field: 'Free', sport: null, _activity: 'Free', _startMin: s, _endMin: e, _fixed: true, _constraintDemoted: true, _demotedReason: 'spacing', continuation: false };
        for (let k = idx + 1; k < slots.length; k++) {
            if (slots[k] && slots[k].continuation) slots[k] = { field: 'Free', sport: null, _activity: 'Free', _fixed: true, _constraintDemoted: true, continuation: false };
            else break;
        }
        return true;
    }

    // ── COMPLIANT REFILL ─────────────────────────────────────────────────────
    // A spacing violation must not just leave a hole: try to put a DIFFERENT
    // valid activity in the slot that does NOT violate spacing, leaving Free only
    // when nothing legal fits (genuinely impossible). Tries the displaced
    // activity's OWN type first (keep the slot's character), then the other type —
    // so under "no sport near lunch" a sport slot can be refilled with a special,
    // and vice-versa. Validation mirrors the existing fill passes (STEP 6.8 / 7.6):
    // field/room must be COMPLETELY free at the slot's time (stricter than sharing →
    // can never create a capacity/share conflict), grade access honored, no same-day
    // repeat, time-restricted fields skipped (conservative), plus isCandidateAllowed
    // for spacing. (Special frequency caps aren't re-checked here — a best-effort
    // fill is preferred to a Free per the requirement; rare and bounded.)
    const _gsR = (window.loadGlobalSettings && window.loadGlobalSettings()) || (window.globalSettings || {});
    const _app1R = _gsR.app1 || _gsR;
    const _fieldsR = (_app1R && _app1R.fields) || _gsR.fields || [];
    const _specialsR = (_app1R && _app1R.specialActivities) || _gsR.specialActivities || [];
    const _nmR = function (s) { return String(s || '').toLowerCase().trim(); };
    const _skipFL = { 'free': 1, 'no field': 1, 'lunch': 1, 'snacks': 1, 'snack': 1, 'dismissal': 1, 'swim': 1, 'pool': 1, 'change': 1, 'cleanup': 1, 'main activity': 1, 'lineup': 1, 'transition': 1, 'buffer': 1, 'davening': 1, 'mincha': 1 };
    const _specialRoomR = {}; _specialsR.forEach(function (s) { if (s && s.location) _specialRoomR[_nmR(s.location)] = 1; });
    const _accessOk = function (ar, grade) { if (!ar || !ar.enabled) return true; const dv = ar.divisions || {}; if (!Object.keys(dv).length) return true; return !!dv[grade]; };
    function _occFree(exclBunk, exclIdx, fl, s, e) {
        const key = _nmR(fl);
        const names = Object.keys(scheduleAssignments);
        for (let bi = 0; bi < names.length; bi++) {
            const b = names[bi]; const arr = scheduleAssignments[b]; if (!Array.isArray(arr)) continue;
            for (let i = 0; i < arr.length; i++) {
                if (String(b) === String(exclBunk) && i === exclIdx) continue;
                const en = arr[i]; if (!en || en.continuation) continue;
                if (_nmR(en.field || en._specialLocation || en.location) !== key) continue;
                const t = slotTime(b, i, en); if (!t) continue;
                if (t.s < e && t.e > s) return false;
            }
        }
        return true;
    }
    // ★ Sharing-aware occupancy: who's on this room/field during [s,e)?
    //   Returns {count, sameGradeOnly} so the refill can SHARE under capacity
    //   (the completely-free-only rule left rule-displaced slots unfillable in
    //   the pre-lunch crunch when every bunk competes for the special rooms).
    function _occInfo(exclBunk, exclIdx, fl, s, e, grade) {
        const key = _nmR(fl);
        let count = 0, sameGradeOnly = true;
        const names = Object.keys(scheduleAssignments);
        for (let bi = 0; bi < names.length; bi++) {
            const b = names[bi]; const arr = scheduleAssignments[b]; if (!Array.isArray(arr)) continue;
            for (let i = 0; i < arr.length; i++) {
                if (String(b) === String(exclBunk) && i === exclIdx) continue;
                const en = arr[i]; if (!en || en.continuation) continue;
                if (_nmR(en.field || en._specialLocation || en.location) !== key) continue;
                const t = slotTime(b, i, en); if (!t) continue;
                if (t.s < e && t.e > s) {
                    count++;
                    if (_b2g[String(b)] !== grade) sameGradeOnly = false;
                }
            }
        }
        return { count: count, sameGradeOnly: sameGradeOnly };
    }
    // Sharing capacity of a room/field from its sharableWith config — mirrors the
    // solvers' normalization: not_sharable→1, explicit capacity wins, 'all'→∞,
    // anything else defaults to 2 (same_division-style).
    function _capOfSW(sw) {
        if (!sw) return 1;
        const t = String(sw.type || sw.shareType || 'not_sharable').toLowerCase();
        if (t === 'not_sharable') return 1;
        const c = parseInt(sw.capacity);
        if (c > 0) return c;
        return t === 'all' ? 999 : 2;
    }
    function refillSlot(bunk, grade, slots, idx, s, e, demotedType, template) {
        const done = {};
        slots.forEach(function (en, i) { if (i !== idx && en && !en.continuation) { const a = en._activity || en.sport || en.event; if (a && !/^free$/i.test(a)) done[_nmR(a)] = 1; } });
        // Shared-room admission: under capacity, and only joining occupants of the
        // SAME grade (conservative — no cross-division pairing logic re-implemented here).
        const roomOpen = function (room, sw) {
            const occ = _occInfo(bunk, idx, room, s, e, grade);
            if (occ.count === 0) return true;
            if (!occ.sameGradeOnly) return false;
            return occ.count < _capOfSW(sw);
        };
        const trySport = function () {
            for (let fi = 0; fi < _fieldsR.length; fi++) {
                const f = _fieldsR[fi]; if (!f || !f.name) continue;
                if (_specialRoomR[_nmR(f.name)]) continue;                       // not a special room
                if (f.available === false) continue;
                if (f.timeRules && f.timeRules.enabled) continue;                // skip time-restricted (conservative)
                if (!Array.isArray(f.activities) || !f.activities.length) continue;
                if (!_accessOk(f.accessRestrictions, grade)) continue;
                if (!roomOpen(f.name, f.sharableWith)) continue;
                for (let ai = 0; ai < f.activities.length; ai++) {
                    const A = f.activities[ai]; if (!A || done[_nmR(A)]) continue;
                    // ★ League-reserved sport (standing rule) — the repair filler must not
                    //   hand a division a sport its league reserves for league play.
                    if (window.SchedulerCoreUtils?.isSportReservedForLeague?.(grade, A)) continue;
                    if (isCandidateAllowed({ type: 'sport', event: A, field: f.name, startMin: s, endMin: e }, template, { mode: mode }))
                        return { field: f.name, act: A, isSpecial: false };
                }
            }
            return null;
        };
        const trySpecial = function () {
            for (let si = 0; si < _specialsR.length; si++) {
                const sp = _specialsR[si]; if (!sp || !sp.name || done[_nmR(sp.name)]) continue;
                const room = sp.location || sp.name;
                if (!_accessOk(sp.accessRestrictions, grade)) continue;
                if (window.SchedulerCoreUtils?.isSportReservedForLeague?.(grade, sp.name)) continue; // league-reserved name parity
                if (!roomOpen(room, sp.sharableWith)) continue;
                let dur = null;
                if (Array.isArray(sp.durations) && sp.durations.filter(Boolean).length) dur = Math.min.apply(null, sp.durations.filter(Boolean));
                else dur = sp.duration || sp.periodMin || null;
                if (dur && (e - s) < dur) continue;                              // slot too short for this special
                if (isCandidateAllowed({ type: 'special', event: sp.name, field: room, _assignedSpecial: sp.name, _specialLocation: room, startMin: s, endMin: e }, template, { mode: mode }))
                    return { field: room, act: sp.name, isSpecial: true };
            }
            return null;
        };
        return (demotedType === 'special') ? (trySpecial() || trySport()) : (trySport() || trySpecial());
    }

    Object.keys(scheduleAssignments).forEach(function (bunk) {
        const slots = scheduleAssignments[bunk];
        if (!Array.isArray(slots)) return;
        const grade = _b2g[String(bunk)];
        for (let round = 0; round < 12; round++) { // bounded: each fix may clear cascading violations
            const blocks = blocksOf(bunk, slots);
            let acted = false;
            for (let a = 0; a < blocks.length && !acted; a++) {
                const T = blocks[a];
                for (let ri = 0; ri < rules.length && !acted; ri++) {
                    const r = rules[ri];
                    if (!blockMatchesDescriptor(T, r.target)) continue;
                    const minutes = parseInt(r.minutes) || 0;
                    const timing = r.timing || 'both';
                    for (let b = 0; b < blocks.length; b++) {
                        if (b === a) continue;
                        const R = blocks[b];
                        if (!blockMatchesDescriptor(R, r.reference)) continue;
                        const gapBefore = R.startMin - T.endMin;
                        const gapAfter = T.startMin - R.endMin;
                        let viol = false;
                        if ((timing === 'before' || timing === 'both') && gapBefore >= 0 && gapBefore < minutes) viol = true;
                        if ((timing === 'after' || timing === 'both') && gapAfter >= 0 && gapAfter < minutes) viol = true;
                        if (!viol) continue;
                        if (T.prot) {
                            if (round === 0) { report.unresolved++; report.details.push({ bunk: bunk, unresolved: T.event, near: R.event }); }
                        } else {
                            // Template = the bunk's OTHER blocks (so the refill candidate is checked
                            // against everything except the slot we're replacing).
                            const template = blocks.filter(function (_x, _i) { return _i !== a; });
                            const fill = refillSlot(bunk, grade, slots, T.idx, T.startMin, T.endMin, T.type, template);
                            if (fill) {
                                slots[T.idx] = {
                                    field: fill.field, sport: fill.isSpecial ? null : fill.act, _activity: fill.act,
                                    _startMin: T.startMin, _endMin: T.endMin, _fixed: true, _spacingRefill: true, continuation: false
                                };
                                if (fill.isSpecial) slots[T.idx]._specialLocation = fill.field;
                                report.refilled++;
                                report.details.push({ bunk: bunk, refilled: fill.act, replaced: T.event, near: R.event });
                            } else {
                                demote(slots, T.idx, T.startMin, T.endMin);
                                report.demoted++;
                                report.details.push({ bunk: bunk, demoted: T.event, near: R.event });
                            }
                            acted = true;
                        }
                        break;
                    }
                }
            }
            if (!acted) break;
        }
    });
    if (report.refilled || report.demoted || report.unresolved) {
        console.log('[SPACING] enforceSpacingSweep (' + mode + '): ' + report.refilled + ' refilled (compliant), ' + report.demoted + ' demoted → Free (unfillable)' + (report.unresolved ? ', ' + report.unresolved + ' unresolved (user-locked)' : ''));
    }
    return report;
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
    enforceSpacingSweep: enforceSpacingSweep,
    describeRule: describeRule
};

console.log('[RULES] rules.js v1.1 ready');
})();
