
// =================================================================
// master_schedule_builder.js (UPDATED - REDESIGNED UI)
// Beta v2.5
// Updates:
// 1. Tile palette on LEFT SIDEBAR with solid colors
// 2. Toolbar: Status+Update | Load | New+Save | Clear | Delete
// 3. Delete key support for removing selected tiles
// 4. In-page modal inputs instead of browser prompts
// 5. Checkbox selection for locations/facilities
// 6. Removed draft restore prompt
// 7. ★ v2.5: Grouped-checkbox modal type for locations (matches DA bunk overrides)
// 8. ★ v2.5: Custom tile pulls grouped locations from locationZones
// 9. ★ v2.5: Split tile uses Main 1/Main 2 + mapEventNameForOptimizer (matches DA)
// =================================================================

(function(){
'use strict';

// ★★★ CB-27/28/29 (+ folds CB-49/86/87): module-level HTML escaper. Layer/tile
// names (customActivity, leagueName) and event names (ev.event) are
// user-controlled and were interpolated RAW into innerHTML — the band label,
// the edit-popover input `value=` attribute, the drag-ghost, and the skeleton
// tile header — yielding stored XSS. The local `_esc` (~L1484) is scoped to a
// single function and not in scope at these sinks; this module-level helper
// covers all of them. Complete `&<>"'` set → safe in element and attribute
// context alike.
const _mbEsc = (s) => (window.CampUtils && window.CampUtils.escapeHtml)
    ? window.CampUtils.escapeHtml(s)
    : String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let container=null, palette=null, grid=null;
let dailySkeleton=[];
let currentLoadedTemplate = null;
let selectedTileId = null;
let builderMode = 'manual';
let hasUnsavedChanges = false;

// Returns the first enabled league assigned to `grade`, or null. Used to
// auto-remap league/specialty_league tiles when copied/dragged into a
// different grade so they don't keep referencing the source grade's league.
function _mbFirstLeagueForGrade(grade) {
  const _gs = window.loadGlobalSettings?.() || {};
  const lbn = _gs.leaguesByName || {};
  const matches = Object.keys(lbn).filter(n =>
    lbn[n] && lbn[n].enabled !== false &&
    Array.isArray(lbn[n].divisions) &&
    lbn[n].divisions.includes(String(grade))
  );
  return matches[0] || null;
}

// Returns ALL leagues assigned to a given grade.
function _mbAllLeaguesForGrade(grade) {
  const _gs = window.loadGlobalSettings?.() || {};
  const lbn = _gs.leaguesByName || {};
  return Object.keys(lbn).filter(n =>
    lbn[n] && lbn[n].enabled !== false &&
    Array.isArray(lbn[n].divisions) &&
    lbn[n].divisions.includes(String(grade))
  );
}
try { window._mbAllLeaguesForGrade = _mbAllLeaguesForGrade; } catch (_) {}

// Specialty leagues live in a SEPARATE store (gs.specialtyLeagues), keyed by
// id with { name, enabled, divisions, ... }. Regular-league dropdowns read
// leaguesByName and never see these, which is why a specialty-league tile used
// to list regular leagues and miss the specialty ones.
function _mbSpecialtyLeaguesForGrade(grade) {
  const _gs = window.loadGlobalSettings?.() || {};
  const sl = _gs.specialtyLeagues || {};
  return Object.values(sl)
    .filter(l => l && l.enabled !== false && l.name &&
      Array.isArray(l.divisions) && l.divisions.includes(String(grade)))
    .map(l => l.name);
}
try { window._mbSpecialtyLeaguesForGrade = _mbSpecialtyLeaguesForGrade; } catch (_) {}

// Pick the right league list for a tile type: a specialty_league tile lists
// specialty leagues, every other league tile lists regular leagues.
function _mbLeaguesForGradeByType(grade, tileType) {
  return tileType === 'specialty_league'
    ? _mbSpecialtyLeaguesForGrade(grade)
    : _mbAllLeaguesForGrade(grade);
}
try { window._mbLeaguesForGradeByType = _mbLeaguesForGradeByType; } catch (_) {}

// Mutates a copied event so its league reference matches the new grade.
// No-op for non-league events. If the target grade has no league, clears
// leagueName + reverts event label so the schedule remains valid.
function _mbRemapLeagueForGrade(ev, newGrade) {
  if (!ev || (ev.type !== 'league' && ev.type !== 'specialty_league')) return ev;
  const newLeague = _mbFirstLeagueForGrade(newGrade);
  if (newLeague) {
    if (ev.leagueName && ev.event === ev.leagueName) ev.event = newLeague;
    ev.leagueName = newLeague;
  } else {
    delete ev.leagueName;
    if (ev.event && ev.event !== 'League Game') ev.event = 'League Game';
  }
  return ev;
}
// Expose so daily_adjustments.js (and any other consumer) can reuse the
// same remap logic without duplicating it.
try { window._mbRemapLeagueForGrade = _mbRemapLeagueForGrade; } catch (_) {}
try { window._mbFirstLeagueForGrade = _mbFirstLeagueForGrade; } catch (_) {}

function _mbIsBackToBack(ev) {
  if (!ev.leagueName || (ev.type !== 'league' && ev.type !== 'specialty_league')) return false;
  const parseT = typeof parseTimeToMinutes === 'function' ? parseTimeToMinutes : window.SchedulerCoreUtils?.parseTimeToMinutes;
  if (!parseT) return false;
  const evStart = parseT(ev.startTime);
  const evEnd = parseT(ev.endTime);
  for (let i = 0; i < dailySkeleton.length; i++) {
    const other = dailySkeleton[i];
    if (other === ev || other.id === ev.id) continue;
    if (other.leagueName !== ev.leagueName) continue;
    if (other.division !== ev.division) continue;
    if (other.type !== 'league' && other.type !== 'specialty_league') continue;
    const oStart = parseT(other.startTime);
    const oEnd = parseT(other.endTime);
    if (Math.abs(oStart - evEnd) <= 5 || Math.abs(evStart - oEnd) <= 5) return true;
  }
  return false;
}

// --- UNIVERSAL BUILDER MODE ---
window.getCampBuilderMode = function() {
  const g = window.loadGlobalSettings?.() || {};
  return g.app1?.builderMode || 'manual';
};
window.setCampBuilderMode = function(mode) {
  const g = window.loadGlobalSettings?.() || {};
  if (!g.app1) g.app1 = {};
  g.app1.builderMode = mode;
  window.saveGlobalSettings?.('app1', g.app1);
  window.forceSyncToCloud?.();
};

let currentBuilderMode = window.getCampBuilderMode();

// --- Constants ---
const SKELETON_DRAFT_KEY = 'master-schedule-draft';
const SKELETON_DRAFT_NAME_KEY = 'master-schedule-draft-name';
const PIXELS_PER_MINUTE=2;
const INCREMENT_MINS=30;
const SNAP_MINS = 5;

// --- Persistence ---
function saveDraftToLocalStorage() {
  try {
    if (dailySkeleton && dailySkeleton.length > 0) {
      localStorage.setItem(SKELETON_DRAFT_KEY, JSON.stringify(dailySkeleton));
      if(currentLoadedTemplate) {
          localStorage.setItem(SKELETON_DRAFT_NAME_KEY, currentLoadedTemplate);
      }
    } else {
      localStorage.removeItem(SKELETON_DRAFT_KEY);
      localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
    }
  } catch (e) { console.error(e); }
}

function clearDraftFromLocalStorage() {
  localStorage.removeItem(SKELETON_DRAFT_KEY);
  localStorage.removeItem(SKELETON_DRAFT_NAME_KEY);
}

function markUnsavedChanges() {
  hasUnsavedChanges = true;
  updateToolbarStatus();
}

// --- Tiles (Soft Pastel Color Palette) ---
const TILES=[
  // Scheduling Slots - Soft blues and greens
  {type:'activity', name:'Activity', style:'background:#93c5fd;color:#1e3a5f;', description:'Flexible slot (Sport or Special).'},
  {type:'sports', name:'Sports', style:'background:#86efac;color:#14532d;', description:'Sports slot only.'},
  {type:'special', name:'Special Activity', style:'background:#c4b5fd;color:#3b1f6b;', description:'Special Activity slot only.'},
  
  // Advanced Tiles
  {type:'smart', name:'Smart Tile', style:'background:#7dd3fc;color:#0c4a6e;border:2px dashed #0284c7;', description:'Fills Main 1 by capacity, rest get Main 2, then swap next period.'},
  {type:'split', name:'Split Activity', style:'background:#fdba74;color:#7c2d12;', description:'Splits division between two tile types, swap midway.'},
  {type:'elective', name:'Elective', style:'background:#f0abfc;color:#701a75;', description:'Reserve multiple activities for this division only.'},
  
  // Leagues
  {type:'league', name:'League Game', style:'background:#a5b4fc;color:#312e81;', description:'Regular League slot (Full Buyout).'},
  {type:'specialty_league', name:'Specialty League', style:'background:#d8b4fe;color:#581c87;', description:'Specialty League slot (Full Buyout).'},
  
  // Pinned Events
  {type:'swim', name:'Swim', style:'background:#67e8f9;color:#155e75;', description:'Pinned.'},
  {type:'swim_elective', name:'Swim + Elective', style:'background:linear-gradient(to right, #67e8f9 0%, #67e8f9 50%, #f0abfc 50%, #f0abfc 100%);color:#155e75;', description:'Hybrid: pool reserved + activities reserved. Created by dropping a Swim onto an Elective (or vice versa).'},
  {type:'lunch', name:'Lunch', style:'background:#fca5a5;color:#7f1d1d;', description:'Pinned.'},
  {type:'snacks', name:'Snacks', style:'background:#fde047;color:#713f12;', description:'Pinned.'},
  {type:'dismissal', name:'Dismissal', style:'background:#f87171;color:#fff;', description:'Pinned.'},
  {type:'custom', name:'Custom Pinned', style:'background:#d1d5db;color:#374151;', description:'Pinned custom (e.g., Regroup).'}
];

// =========================================================================
// SWIM + ELECTIVE MERGE HELPERS
// When a user drops swim onto an existing elective (or vice versa), prompt
// to merge into a single hybrid 'swim_elective' tile.
// =========================================================================
function isSwimEvent(ev) {
  if (!ev) return false;
  return (ev.type === 'pinned' && /^swim$/i.test(ev.event || ''));
}
function isElectiveEvent(ev) {
  return !!ev && ev.type === 'elective';
}
function buildSwimElectiveHybrid(newEvent, existingEvent, divName) {
  const swimEv = isSwimEvent(newEvent) ? newEvent : existingEvent;
  const electiveEv = isElectiveEvent(newEvent) ? newEvent : existingEvent;
  // Use the new event's time range as the hybrid's window.
  const swimLoc = swimEv.location ||
    (Array.isArray(swimEv.reservedFields) && swimEv.reservedFields[0]) || null;
  // Prefer electiveActivities; fall back to reservedFields when missing.
  let electiveActs = electiveEv.electiveActivities;
  if (!Array.isArray(electiveActs) || !electiveActs.length) electiveActs = electiveEv.reservedFields || [];
  const electiveFields = electiveEv.reservedFields || [];
  const combinedFields = Array.from(new Set([
    ...(swimLoc ? [swimLoc] : []),
    ...electiveFields
  ]));
  return {
    id: 'hybrid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    type: 'swim_elective',
    event: 'Swim + Elective',
    division: divName,
    startTime: newEvent.startTime,
    endTime: newEvent.endTime,
    // Swim half:
    _preChangeMin: swimEv._preChangeMin,
    _postChangeMin: swimEv._postChangeMin,
    fullGrade: swimEv.fullGrade,
    swimLocation: swimLoc,
    // Elective half:
    electiveActivities: electiveActs,
    reservedFields: combinedFields
  };
}
async function tryMergeSwimElective(newEvent, divName, skeleton) {
  const newIsSwim = isSwimEvent(newEvent);
  const newIsElective = isElectiveEvent(newEvent);
  console.log('[MERGE] check', { newType: newEvent.type, newEvent: newEvent.event, newIsSwim, newIsElective, divName, skelLen: skeleton.length });
  if (!newIsSwim && !newIsElective) return null;
  const newStart = parseTimeToMinutes(newEvent.startTime);
  const newEnd = parseTimeToMinutes(newEvent.endTime);
  if (newStart === null || newEnd === null) return null;
  const overlap = skeleton.find(ex => {
    if (ex.division !== divName) return false;
    if (ex.id === newEvent.id) return false;
    const xs = parseTimeToMinutes(ex.startTime);
    const xe = parseTimeToMinutes(ex.endTime);
    if (xs === null || xe === null) return false;
    if (!(xs < newEnd && xe > newStart)) return false;
    const exIsSwim = isSwimEvent(ex);
    const exIsElective = isElectiveEvent(ex);
    console.log('[MERGE]   overlap candidate', { exType: ex.type, exEvent: ex.event, exIsSwim, exIsElective, xs, xe, newStart, newEnd });
    if (newIsSwim && exIsElective) return true;
    if (newIsElective && exIsSwim) return true;
    return false;
  });
  console.log('[MERGE] result', overlap ? 'FOUND match - prompting' : 'no match');
  if (!overlap) return null;
  const droppedKind = newIsSwim ? 'Swim' : 'Elective';
  const existingKind = newIsSwim ? 'Elective' : 'Swim';
  const ok = await showConfirm(
    `Merge ${droppedKind} with the existing ${existingKind} into one hybrid tile?\n\n` +
    `The combined tile will reserve the pool AND the elective activities at the same time, so some campers can swim while others use the reserved fields.`
  );
  if (!ok) return null;
  return {
    hybrid: buildSwimElectiveHybrid(newEvent, overlap, divName),
    overlapId: overlap.id,
    swimEvent: newIsSwim ? newEvent : overlap
  };
}

function mapEventNameForOptimizer(name){
  if(!name) name='Free';
  const lower=name.toLowerCase().trim();
  if(lower==='activity') return {type:'slot',event:'General Activity Slot'};
  if(lower==='sports') return {type:'slot',event:'Sports Slot'};
  if(lower==='special activity'||lower==='special') return {type:'slot',event:'Special Activity'};
  if(['swim','lunch','snacks','dismissal'].includes(lower)) return {type:'pinned',event:name};
  return {type:'pinned',event:name};
}

// =================================================================
// MODAL SYSTEM - Replace browser prompts with in-page modals
// =================================================================
function showModal(config) {
  return new Promise((resolve) => {
    // Remove existing modal
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal">
        <div class="ms-modal-header">
          <h3>${config.title || 'Input Required'}</h3>
          <button class="ms-modal-close">&times;</button>
        </div>
        <div class="ms-modal-body">
          ${config.description ? `<p class="ms-modal-desc">${config.description}</p>` : ''}
          <div class="ms-modal-fields"></div>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-ghost ms-modal-cancel">Cancel</button>
          <button class="ms-btn ms-btn-primary ms-modal-confirm">${config.confirmText || 'Confirm'}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    const fieldsContainer = overlay.querySelector('.ms-modal-fields');
    const inputs = {};
    
    // Build fields
    (config.fields || []).forEach(field => {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'ms-modal-field';
      
      if (field.type === 'text' || field.type === 'time') {
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <input type="${field.type === 'time' ? 'text' : 'text'}" 
                 class="ms-modal-input" 
                 data-field="${field.name}"
                 value="${field.default || ''}"
                 placeholder="${field.placeholder || ''}">
        `;
        inputs[field.name] = () => fieldEl.querySelector('input').value;
      }
      else if (field.type === 'select') {
        const options = (field.options || []).map(o => {
          const val = (o.value !== undefined) ? o.value : o;
          return `<option value="${val}" ${val === field.default ? 'selected' : ''}>${o.label || o}</option>`;
        }).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <select class="ms-modal-input" data-field="${field.name}">
            ${options}
          </select>
        `;
        inputs[field.name] = () => fieldEl.querySelector('select').value;
      }
      else if (field.type === 'checkbox-group') {
        const _cbDefaults = Array.isArray(field.default) ? field.default : [];
        const checkboxes = (field.options || []).map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lbl = typeof o === 'object' ? o.label : o;
          const dis = typeof o === 'object' && o.disabled;
          const reason = dis && o.disabledReason ? ` title="${o.disabledReason}"` : '';
          const chk = !dis && _cbDefaults.includes(val) ? ' checked' : '';
          return `<label class="ms-checkbox-item${dis ? ' ms-cb-disabled' : ''}"${reason} style="${dis ? 'opacity:0.45;pointer-events:none;' : ''}">
            <input type="checkbox" value="${val}" data-group="${field.name}"${chk}${dis ? ' disabled' : ''}>
            <span>${lbl}${dis ? ' <em style="font-size:9px;">(taken)</em>' : ''}</span>
          </label>`;
        }).join('');
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <div class="ms-checkbox-group">${checkboxes}</div>
        `;
        inputs[field.name] = () => {
          const checked = fieldEl.querySelectorAll(`input[data-group="${field.name}"]:checked`);
          return Array.from(checked).map(c => c.value);
        };
      }
      // ★ v2.5: Grouped checkbox - renders checkboxes with category headers (like DA bunk overrides)
      else if (field.type === 'grouped-checkbox') {
        let groupsHTML = '';
        const _gcDefaults = Array.isArray(field.default) ? field.default : [];
        (field.groups || []).forEach(group => {
          if (!group.options || group.options.length === 0) return;
          groupsHTML += `<div class="ms-checkbox-group-header">${group.label}</div>`;
          groupsHTML += `<div class="ms-checkbox-group-items">`;
          group.options.forEach(o => {
            const val = typeof o === 'object' ? o.value : o;
            const display = typeof o === 'object' ? o.label : o;
            groupsHTML += `
              <label class="ms-checkbox-item">
                <input type="checkbox" value="${val}" data-group="${field.name}"${_gcDefaults.includes(val) ? ' checked' : ''}>
                <span>${display}</span>
              </label>`;
          });
          groupsHTML += `</div>`;
        });
        if (!groupsHTML) {
          groupsHTML = `<div class="ms-checkbox-group-empty">No locations configured. Add them in Setup → Location Zones.</div>`;
        }
        fieldEl.innerHTML = `
          <label>${field.label}</label>
          <div class="ms-checkbox-grouped">${groupsHTML}</div>
        `;
        inputs[field.name] = () => {
          const checked = fieldEl.querySelectorAll(`input[data-group="${field.name}"]:checked`);
          return Array.from(checked).map(c => c.value);
        };
      }
      
      fieldsContainer.appendChild(fieldEl);
    });
    
    if (config.postRender) config.postRender(overlay);

    // Focus first input
    setTimeout(() => {
      const firstInput = overlay.querySelector('.ms-modal-input');
      if (firstInput) firstInput.focus();
    }, 50);

    // Event handlers
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    
    overlay.querySelector('.ms-modal-close').onclick = () => close(null);
    overlay.querySelector('.ms-modal-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    
    overlay.querySelector('.ms-modal-confirm').onclick = () => {
      const result = {};
      Object.keys(inputs).forEach(key => {
        result[key] = inputs[key]();
      });
      // Also collect values from dynamically added fields (e.g. postRender injections)
      overlay.querySelectorAll('[data-field]').forEach(el => {
        const key = el.getAttribute('data-field');
        if (!(key in result)) {
          result[key] = (el.value || '').trim();
        }
      });
      close(result);
    };
    
    // Enter key to confirm
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        overlay.querySelector('.ms-modal-confirm').click();
      }
      if (e.key === 'Escape') close(null);
    });
  });
}

// ★ Smart Tile "Guarantee swap" control (shared by the create + edit dialogs).
//   Injects a checkbox; when ticked it HIDES the Fallback field (in swap mode
//   Main 2 IS the open side, so no separate fallback) and shows an explanation of
//   the switch. Carries the flag out of the modal via a hidden [data-field] input
//   that showModal's value collector reads (same pattern as the split bunk picker).
function _mbSmartSwapPostRender(overlay, defaultOn) {
  if (!overlay) return;
  const fields = overlay.querySelector('.ms-modal-fields');
  if (!fields) return;
  const fbInput = overlay.querySelector('[data-field="fallbackActivity"]');
  const fbRow = fbInput ? fbInput.closest('.ms-modal-field') : null;
  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.setAttribute('data-field', 'guaranteeSwap');
  hidden.value = defaultOn ? 'true' : 'false';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:10px 0;padding:12px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;';
  wrap.innerHTML =
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:#5b21b6;">'
    + '<input type="checkbox" class="mb-gs-cb"' + (defaultOn ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer;flex:none;">'
    + 'Guarantee each bunk gets both (swap)</label>'
    + '<div class="mb-gs-explain" style="' + (defaultOn ? '' : 'display:none;') + 'font-size:11px;color:#6d28d9;margin-top:8px;line-height:1.5;">'
    + 'The division splits into two groups across the two periods. One group does <b>Main 1</b> first, then switches to <b>Main 2</b>; the other does <b>Main 2</b> first, then <b>Main 1</b>. <b>Every bunk gets one of each.</b> Main 2 covers everyone not on Main 1, so no separate Fallback is needed, and the split adjusts to capacity so neither period runs short.'
    + '</div>';
  if (fbRow && fbRow.parentNode === fields) fields.insertBefore(wrap, fbRow);
  else fields.appendChild(wrap);
  fields.appendChild(hidden);
  const cb = wrap.querySelector('.mb-gs-cb');
  const explain = wrap.querySelector('.mb-gs-explain');
  function _gsSync() {
    const on = !!cb.checked;
    hidden.value = on ? 'true' : 'false';
    if (explain) explain.style.display = on ? 'block' : 'none';
    if (fbRow) fbRow.style.display = on ? 'none' : '';
  }
  cb.addEventListener('change', _gsSync);
  _gsSync();
}

// ★ "Away" (off-campus) control for Sports + League tile edit dialogs.
//   Injects a checkbox; when ticked it reveals a zone picker listing the
//   off-campus zones (window.getAwayZones). A tile marked Away is restricted at
//   generation to the chosen zone's fields, and the zone's travel time is added
//   to/from the tile. Carries the boolean out of the modal via a hidden
//   [data-field="isAway"] input (same pattern as the smart-swap control); the
//   zone <select> carries data-field="awayZone" so showModal collects it too.
function _mbTileSupportsAway(ev) {
  if (!ev) return false;
  if (ev.type === 'league' || ev.type === 'specialty_league') return true;
  if (ev.type === 'sports') return true;
  return /\bsport/i.test(String(ev.event || ''));
}

function _mbAwayPostRender(overlay, ev) {
  if (!overlay) return;
  const fields = overlay.querySelector('.ms-modal-fields');
  if (!fields) return;
  const esc = (s) => (window.CampUtils?.escapeHtml ? window.CampUtils.escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const zones = (typeof window.getAwayZones === 'function') ? window.getAwayZones() : [];

  const curZone = (ev.awayZone && zones.some(z => z.name === ev.awayZone)) ? ev.awayZone : (zones[0] ? zones[0].name : '');
  const defaultOn = !!ev.isAway && !!curZone;
  const hasZones = zones.length > 0;

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.setAttribute('data-field', 'isAway');
  hidden.value = defaultOn ? 'true' : 'false';

  const optsHtml = zones.map(z => {
    const t = z.travelTimeMin > 0 ? ' — ' + z.travelTimeMin + ' min travel each way' : '';
    return '<option value="' + esc(z.name) + '"' + (z.name === curZone ? ' selected' : '') + '>' + esc(z.name) + esc(t) + '</option>';
  }).join('');

  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:10px 0;padding:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;';
  const _mode = (ev.awayMode === 'mixed') ? 'mixed' : 'exclusive';
  const bodyHtml = hasZones
    ? ('<div class="mb-away-body" style="' + (defaultOn ? '' : 'display:none;') + 'margin-top:10px;">'
        + '<label style="font-size:12px;font-weight:600;color:#7c2d12;display:block;margin-bottom:4px;">Away zone</label>'
        + '<select class="ms-modal-input mb-away-zone" data-field="awayZone" style="width:100%;">' + optsHtml + '</select>'
        + '<label style="font-size:12px;font-weight:600;color:#7c2d12;display:block;margin:10px 0 4px;">How many go away?</label>'
        + '<select class="ms-modal-input mb-away-mode" data-field="awayMode" style="width:100%;">'
        + '<option value="exclusive"' + (_mode === 'exclusive' ? ' selected' : '') + '>All away — only off-campus fields</option>'
        + '<option value="mixed"' + (_mode === 'mixed' ? ' selected' : '') + '>Either / or — some away, some stay on campus</option>'
        + '</select>'
        + '<div style="font-size:11px;color:#9a3412;margin-top:6px;line-height:1.5;">Adds the zone\'s travel time to and from. <strong>All away</strong> forces every game to the off-campus fields; <strong>Either/or</strong> also allows on-campus fields, so games spill back home once the zone fills.</div>'
        + '</div>')
    : ('<div style="font-size:11px;color:#9a3412;margin-top:8px;line-height:1.5;">No off-campus zones yet. Add one in <strong>Setup → Location Zones</strong> (mark it “Off-campus” and set a travel time), then re-open this tile.</div>');
  wrap.innerHTML =
    '<label style="display:flex;align-items:center;gap:8px;cursor:' + (hasZones ? 'pointer' : 'not-allowed') + ';font-size:13px;font-weight:600;color:#9a3412;">'
    + '<input type="checkbox" class="mb-away-cb"' + (defaultOn ? ' checked' : '') + (hasZones ? '' : ' disabled') + ' style="width:16px;height:16px;cursor:' + (hasZones ? 'pointer' : 'not-allowed') + ';flex:none;">'
    + 'Away (off-campus)</label>'
    + bodyHtml;
  fields.appendChild(wrap);
  fields.appendChild(hidden);

  const cb = wrap.querySelector('.mb-away-cb');
  const body = wrap.querySelector('.mb-away-body');
  function _awaySync() {
    const on = !!(cb && cb.checked);
    hidden.value = on ? 'true' : 'false';
    if (body) body.style.display = on ? 'block' : 'none';
  }
  if (cb) cb.addEventListener('change', _awaySync);
  _awaySync();
}

// ★ Delete button for the Smart Tile EDIT dialog — it previously had none (you had
//   to cancel and use the tile's action bar). Injected into the modal footer;
//   deletes the tile via the existing deleteTile() and closes the dialog.
function _mbInjectDeleteButton(overlay, tileId) {
  if (!overlay || !tileId) return;
  const footer = overlay.querySelector('.ms-modal-footer');
  if (!footer || footer.querySelector('.ms-modal-delete')) return;
  const btn = document.createElement('button');
  btn.className = 'ms-btn ms-modal-delete';
  btn.textContent = '🗑 Delete';
  btn.style.cssText = 'background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-right:auto;';
  btn.onclick = function () {
    if (typeof deleteTile === 'function') deleteTile(tileId);
    const c = overlay.querySelector('.ms-modal-cancel');
    if (c) c.click(); else overlay.remove();
  };
  footer.insertBefore(btn, footer.firstChild);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal ms-modal-confirm">
        <div class="ms-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-ghost ms-modal-cancel">Cancel</button>
          <button class="ms-btn ms-btn-primary ms-modal-confirm-btn">Confirm</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    overlay.querySelector('.ms-modal-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.ms-modal-confirm-btn').onclick = () => { overlay.remove(); resolve(true); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

function showAlert(message) {
  return new Promise((resolve) => {
    const existing = document.getElementById('ms-modal-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'ms-modal-overlay';
    overlay.innerHTML = `
      <div class="ms-modal ms-modal-alert">
        <div class="ms-modal-body" style="padding:24px;">
          <p style="margin:0;font-size:14px;color:#334155;">${message}</p>
        </div>
        <div class="ms-modal-footer">
          <button class="ms-btn ms-btn-primary ms-modal-ok">OK</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    overlay.querySelector('.ms-modal-ok').onclick = () => { overlay.remove(); resolve(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
  });
}

// =================================================================
// COPY GRADE MODAL — Copy skeleton from one division to others
// =================================================================
function showCopyGradeModal(skeleton, onApply) {
  const _rawDivs = window.availableDivisions || Object.keys(window.divisions || {});
  const divisions = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(_rawDivs.slice()) : _rawDivs;
  if (divisions.length < 2) { showAlert('Need at least 2 grades to copy between.'); return; }

  // Find which divisions have events
  const divsWithEvents = new Set(skeleton.map(ev => ev.division).filter(Boolean));

  const existing = document.getElementById('ms-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ms-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'ms-modal';
  modal.style.cssText = 'max-width:440px; width:90%;';

  modal.innerHTML = `
    <div style="padding:20px 24px 0;">
      <h3 style="margin:0 0 4px; font-size:1.05rem; color:#1E293B;">Copy Grade Schedule</h3>
      <p style="margin:0 0 16px; font-size:0.82rem; color:#64748B;">Copy the skeleton from one grade and apply it to one or more other grades.</p>
    </div>
    <div style="padding:0 24px 20px;">
      <label style="font-size:0.85rem; font-weight:600; color:#374151; display:block; margin-bottom:6px;">Copy from:</label>
      <select id="cg-from" style="width:100%; padding:8px 12px; border:1px solid #D1D5DB; border-radius:8px; font-size:0.9rem; margin-bottom:16px;">
        <option value="">Select source grade...</option>
        ${divisions.map(d => `<option value="${d}" ${divsWithEvents.has(d) ? '' : 'disabled'}>${d}${divsWithEvents.has(d) ? '' : ' (empty)'}</option>`).join('')}
      </select>

      <label style="font-size:0.85rem; font-weight:600; color:#374151; display:block; margin-bottom:6px;">Copy to:</label>
      <div id="cg-targets" style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto; margin-bottom:16px;">
      </div>
    </div>
    <div class="ms-modal-footer" style="display:flex; gap:8px; justify-content:flex-end; padding:12px 24px; border-top:1px solid #E5E7EB;">
      <button id="cg-cancel" class="ms-btn ms-btn-ghost">Cancel</button>
      <button id="cg-apply" class="ms-btn ms-btn-primary" disabled>Copy</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const fromSelect = modal.querySelector('#cg-from');
  const targetsDiv = modal.querySelector('#cg-targets');
  const applyBtn = modal.querySelector('#cg-apply');
  let selectedTargets = new Set();

  function renderTargets() {
    const sourceDiv = fromSelect.value;
    targetsDiv.innerHTML = '';
    selectedTargets.clear();

    if (!sourceDiv) {
      targetsDiv.innerHTML = '<div style="color:#9CA3AF; font-size:0.82rem; padding:8px;">Select a source grade first.</div>';
      applyBtn.disabled = true;
      return;
    }

    divisions.filter(d => d !== sourceDiv).forEach(d => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 12px; background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px; cursor:pointer; user-select:none;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = d;
      cb.style.cssText = 'width:16px; height:16px; accent-color:#147D91;';
      cb.onchange = () => {
        if (cb.checked) selectedTargets.add(d);
        else selectedTargets.delete(d);
        applyBtn.disabled = selectedTargets.size === 0;
      };

      const label = document.createElement('span');
      label.style.cssText = 'font-size:0.88rem; color:#1F2937;';
      label.textContent = d;

      const hasEvents = divsWithEvents.has(d);
      if (hasEvents) {
        const warn = document.createElement('span');
        warn.style.cssText = 'font-size:0.7rem; color:#D97706; margin-left:auto;';
        warn.textContent = 'has events (will be replaced)';
        row.appendChild(cb); row.appendChild(label); row.appendChild(warn);
      } else {
        row.appendChild(cb); row.appendChild(label);
      }

      targetsDiv.appendChild(row);
    });

    // Select all button
    const selectAllRow = document.createElement('div');
    selectAllRow.style.cssText = 'display:flex; justify-content:flex-end; margin-top:4px;';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.style.cssText = 'font-size:0.78rem; color:#147D91; background:none; border:none; cursor:pointer; text-decoration:underline;';
    selectAllBtn.onclick = () => {
      targetsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        selectedTargets.add(cb.value);
      });
      applyBtn.disabled = false;
    };
    selectAllRow.appendChild(selectAllBtn);
    targetsDiv.appendChild(selectAllRow);
  }

  fromSelect.onchange = renderTargets;
  renderTargets();

  modal.querySelector('#cg-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  applyBtn.onclick = () => {
    const sourceDiv = fromSelect.value;
    if (!sourceDiv || selectedTargets.size === 0) return;

    // Get source events. ★ Exclude league / specialty-league tiles: leagues are a
    // camp-level system, not a per-grade layout choice. Silently copying a grade's
    // league layer into other grades makes the auto builder schedule league games
    // for grades the user never set up (the "why are there leagues with no league
    // layer?" surprise from a copied layout). All other layer types — sport,
    // special, swim, custom — copy as before.
    const _isLeagueType = (t) => { const x = String(t || '').toLowerCase(); return x === 'league' || x === 'specialty_league'; };
    const sourceEvents = skeleton.filter(ev => ev.division === sourceDiv && !_isLeagueType(ev.type));
    if (sourceEvents.length === 0) { overlay.remove(); showAlert('Source grade has no copyable events (league tiles are not copied).'); return; }

    // Remove existing events for target divisions
    let updated = skeleton.filter(ev => !selectedTargets.has(ev.division));

    // Copy source events to each target. Remap league references so a
    // league tile copied into a new grade lands on a league assigned to
    // THAT grade — not the source grade's league.
    selectedTargets.forEach(targetDiv => {
      sourceEvents.forEach(ev => {
        const _copy = {
          ...JSON.parse(JSON.stringify(ev)),
          division: targetDiv,
          id: 'evt_' + Math.random().toString(36).slice(2, 9)
        };
        _mbRemapLeagueForGrade(_copy, targetDiv);
        updated.push(_copy);
      });
    });

    overlay.remove();
    onApply(updated);
  };
}

// =================================================================
// Get all available locations (fields + facilities + locations + special activities)
// =================================================================
function getAllLocations() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  
  // Helper to extract names from array (handles strings and objects)
  const extractNames = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.name || item.label || item.title || item.location || null;
      return null;
    }).filter(Boolean);
  };
  
  // Get from all possible sources in app1
  const fields = extractNames(app1.fields);
  const specialActivities = extractNames(app1.specialActivities);
  const facilities = extractNames(app1.facilities);
  const locations = extractNames(app1.locations);
  
  // Also check for top-level in globalSettings
  const topLevelLocations = extractNames(globalSettings.locations);
  const topLevelFacilities = extractNames(globalSettings.facilities);
  
  // Check window.locations if it exists
  const windowLocations = extractNames(window.locations);
  
  // Check if there's a getLocations function
  const funcLocations = extractNames(window.getLocations?.());
  
  // Check window.globalSettings directly
  const directSettings = window.globalSettings || {};
  const directLocations = extractNames(directSettings.locations);
  const directFacilities = extractNames(directSettings.facilities);
  const directApp1Locations = extractNames(directSettings.app1?.locations);
  const directApp1Facilities = extractNames(directSettings.app1?.facilities);

  // Live in-memory sources — more up-to-date than storage snapshots above
  const liveFacilities = extractNames(window.getFacilities?.());
  const liveSpecials = extractNames(window.getGlobalSpecialActivities?.());

  // Combine all and remove duplicates
  const all = [...new Set([
    ...fields,
    ...facilities,
    ...locations,
    ...topLevelLocations,
    ...topLevelFacilities,
    ...windowLocations,
    ...funcLocations,
    ...directLocations,
    ...directFacilities,
    ...directApp1Locations,
    ...directApp1Facilities,
    ...specialActivities,
    ...liveFacilities,
    ...liveSpecials
  ])].filter(Boolean).sort();
  
  console.log('[getAllLocations] Searched sources:', { 
    'app1.fields': fields,
    'app1.facilities': facilities, 
    'app1.locations': locations, 
    'globalSettings.locations': topLevelLocations,
    'window.locations': windowLocations,
    'getLocations()': funcLocations,
    'app1.specialActivities': specialActivities, 
    'COMBINED': all 
  });
  
  return all;
}

// Returns Set of facility names already reserved by other elective tiles that overlap the given time range
function getConflictingFacilities(startTime, endTime, excludeId) {
  const s = parseTimeToMinutes(startTime), e = parseTimeToMinutes(endTime);
  if (s === null || e === null) return new Set();
  const taken = new Set();
  (dailySkeleton || []).forEach(ev => {
    if (ev.id === excludeId || ev.type !== 'elective') return;
    const es = parseTimeToMinutes(ev.startTime), ee = parseTimeToMinutes(ev.endTime);
    if (es === null || ee === null) return;
    if (s < ee && e > es) (ev.electiveActivities || []).forEach(a => taken.add(a));
  });
  return taken;
}

// Returns { activityName: [facilityName, ...] } from fields[].activities
function getSportFacilitiesMap() {
  const gs = window.loadGlobalSettings?.() || {};
  const map = {};
  (gs.app1?.fields || []).forEach(f => {
    (f.activities || []).forEach(act => {
      const key = typeof act === 'string' ? act : (act.name || String(act));
      if (!map[key]) map[key] = [];
      if (f.name && !map[key].includes(f.name)) map[key].push(f.name);
    });
  });
  return map;
}

// =================================================================
// ★ v2.5: Build grouped location options (matches DA bunk overrides pattern)
// =================================================================
function getGroupedLocationOptions() {
  const globalSettings = window.loadGlobalSettings?.() || {};
  const app1 = globalSettings.app1 || {};
  
  // Get facilities from locationZones (Pool, Lunchroom, Gym, etc.)
  const locationZones = globalSettings.locationZones || {};
  const facilities = [];
  Object.entries(locationZones).forEach(([zoneName, zone]) => {
    if (zone && zone.locations) {
      Object.keys(zone.locations).forEach(locName => {
        facilities.push({ value: locName, label: `${locName} (${zoneName})` });
      });
    }
  });
  
  // Get pinned tile defaults (Swim → Pool, Lunch → Lunchroom, etc.)
  // Use live API so recently-saved defaults are visible immediately
  const pinnedDefaults = window.getPinnedTileDefaults?.() || globalSettings.pinnedTileDefaults || {};
  const pinnedOptions = Object.entries(pinnedDefaults).map(([act, loc]) => ({
    value: loc, label: `${act} → ${loc}`
  }));
  
  // Get fields
  const allFields = (app1.fields || []).map(f => ({
    value: f.name,
    label: f.name + (f.rainyDayAvailable ? ' 🏠' : '')
  }));
  
  // Get special activities — prefer live in-memory cache over stale app1 snapshot
  const allSpecials = (window.getGlobalSpecialActivities?.() || app1.specialActivities || []).map(s => ({
    value: s.name, label: s.name
  }));
  
  // Build groups array (only include non-empty groups)
  const groups = [];
  if (pinnedOptions.length > 0) groups.push({ label: 'Pinned Defaults', options: pinnedOptions });
  if (facilities.length > 0) groups.push({ label: 'Facilities', options: facilities });
  if (allFields.length > 0) groups.push({ label: 'Fields', options: allFields });
  if (allSpecials.length > 0) groups.push({ label: 'Special Activities', options: allSpecials });
  
  const hasAny = groups.some(g => g.options.length > 0);
  return { groups, hasAny };
}

// =================================================================
// Swim/Pool Alias Handling
// =================================================================
const SWIM_POOL_PATTERNS = ['swim', 'pool', 'swimming', 'aquatics'];

function isSwimPoolAlias(name) {
  const lower = (name || '').toLowerCase().trim();
  // ★ v2.6 FIX: Use word-boundary regex instead of substring to avoid
  // false positives like "Carpool", "Aquamarine", "Poolside BBQ"
  return SWIM_POOL_PATTERNS.some(p => new RegExp(`\\b${p}\\b`).test(lower));
}

function findPoolField(allLocations) {
  for (const loc of allLocations) {
    if (isSwimPoolAlias(loc)) return loc;
  }
  return null;
}

// --- Init ---
function init(targetElement = null){
  container = targetElement || document.getElementById("master-scheduler-content");
  if(!container) return;

  // 1. FRESH FETCH: Dynamically check the universal setting so it updates instantly
  if (window.getCampBuilderMode) {
      currentBuilderMode = window.getCampBuilderMode();
  }
  
  // 2. CLEAR MEMORY: Reset the locked template so Day Assignments trigger correctly
  currentLoadedTemplate = null;
    
  // Only load manual skeleton in manual mode
  if (currentBuilderMode !== 'auto') {
    loadDailySkeleton();
  } else {
    dailySkeleton = []; // Clean slate for auto mode
  }
  
  // Reset unsaved changes since we just loaded fresh
  hasUnsavedChanges = false;

  // Only restore manual draft in manual mode — don't contaminate auto mode
  if (currentBuilderMode !== 'auto') {
    // Silently restore draft without prompting
    const savedDraft = localStorage.getItem(SKELETON_DRAFT_KEY);
    const savedDraftName = localStorage.getItem(SKELETON_DRAFT_NAME_KEY);
    if (savedDraft) {
      try {
        dailySkeleton = JSON.parse(savedDraft);
        if(savedDraftName) currentLoadedTemplate = savedDraftName;
        // Draft means there might be unsaved changes
        hasUnsavedChanges = true;
      } catch(e) {
        clearDraftFromLocalStorage();
      }
    }
  }

  // Inject HTML with new layout
  container.innerHTML = `
    
      
    <!-- Manual Mode Container (current system) -->
    <div class="ms-container" id="ms-manual-container" style="border-radius:0 0 12px 12px;">
      <!-- Left Sidebar -->
      <div class="ms-sidebar">
        <div class="ms-sidebar-brand">Tiles</div>
        <div id="scheduler-palette" class="ms-palette"></div>
      </div>
      
      <!-- Main Content -->
      <div class="ms-main">
        <div id="scheduler-toolbar" class="ms-toolbar"></div>
        <div id="scheduler-expand" class="ms-expand"></div>
        <div class="ms-grid-wrapper">
          <div id="scheduler-grid"></div>
        </div>
      </div>
    </div>
    
    <!-- Auto Mode Container (DAW layer timeline) -->
    <div id="ms-auto-container" class="ms-container" style="display:none; border-radius:0 0 12px 12px; background:#fff;">
      <!-- DAW Sidebar -->
      <div class="ms-daw-sidebar">
        <div class="ms-daw-sidebar-brand">Layers</div>
        <div id="daw-palette" class="ms-daw-palette"></div>
      </div>
      
      <!-- DAW Main -->
      <div class="ms-auto-container" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
        <div id="daw-toolbar" class="ms-toolbar"></div>
        <div id="daw-expand" class="ms-expand"></div>
        <div id="daw-period-panel" style="display:none; border-bottom:1px solid #e2e8f0; overflow:hidden; max-height:420px; overflow-y:auto;"></div>
        <div class="ms-daw-wrapper">
          <div id="daw-grid" class="ms-daw-grid"></div>
        </div>
      </div>
    </div>
  `;
    
  palette = document.getElementById("scheduler-palette");
  grid = document.getElementById("scheduler-grid");
    
  builderMode = window.getCampBuilderMode ? window.getCampBuilderMode() : 'manual';
  console.log('[MasterBuilder] Mode:', builderMode);

  renderToolbar();
  renderExpandSection();
  renderPalette();
  renderGrid();
  
  // Force UI to match current universal mode immediately on load
  const manualEl = document.getElementById('ms-manual-container');
  const autoEl = document.getElementById('ms-auto-container');
  if (currentBuilderMode === 'manual') {
    if (manualEl) manualEl.style.display = 'flex';
    if (autoEl) autoEl.style.display = 'none';
  } else {
    if (manualEl) manualEl.style.display = 'none';
    if (autoEl) autoEl.style.display = 'flex';
    renderDAW();
  }

  // Global keyboard listener for Delete key
  document.addEventListener('keydown', handleKeyDown);
}

function handleKeyDown(e) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // Don't trigger if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    
    if (selectedTileId) {
      e.preventDefault();
      deleteTile(selectedTileId);
    }
  }
  // Escape to deselect
  if (e.key === 'Escape') {
    deselectAllTiles();
  }
}

function selectTile(id) {
  deselectAllTiles();
  selectedTileId = id;
  const el = grid.querySelector(`.grid-event[data-id="${id}"]`);
  if (el) el.classList.add('selected');
}

function deselectAllTiles() {
  selectedTileId = null;
  grid.querySelectorAll('.grid-event.selected').forEach(el => el.classList.remove('selected'));
}

async function deleteTile(id) {
  const confirmed = await showConfirm('Delete this block?');
  if (confirmed) {
    dailySkeleton = dailySkeleton.filter(x => x.id !== id);
    selectedTileId = null;
    markUnsavedChanges();
    saveDraftToLocalStorage();
    renderGrid();
  }
}

function _buildSplitBunkPicker(overlay, divName, existingGroup1) {
  const sortNum = (arr) => [...arr].sort((a, b) => {
    const nA = parseInt(a.match(/\d+/)?.[0] || 0);
    const nB = parseInt(b.match(/\d+/)?.[0] || 0);
    return nA - nB || a.localeCompare(b);
  });
  const allBunks = sortNum(((window.divisions || {})[divName]?.bunks || []).map(String));
  if (allBunks.length === 0) return;

  const half = Math.ceil(allBunks.length / 2);
  const g1Set = new Set(
    existingGroup1?.length
      ? sortNum(existingGroup1.map(String).filter(b => allBunks.includes(b)))
      : allBunks.slice(0, half)
  );
  const g2Set = new Set(allBunks.filter(b => !g1Set.has(b)));

  const pickerWrap = document.createElement('div');
  pickerWrap.style.cssText = 'margin-top:12px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;';
  pickerWrap.innerHTML =
    '<div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:8px;">Bunk Groups'
    + '<span style="font-size:10px;font-weight:400;color:#64748b;"> — click a bunk to move it</span></div>'
    + '<div style="display:flex;gap:12px;">'
    + '<div style="flex:1;"><div style="font-size:11px;font-weight:600;color:#1e40af;margin-bottom:4px;">● Group 1 → starts at Main 1</div>'
    + '<div id="split-g1-panel" style="min-height:32px;background:#eff6ff;border:1px dashed #93c5fd;border-radius:6px;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;"></div></div>'
    + '<div style="flex:1;"><div style="font-size:11px;font-weight:600;color:#7c3aed;margin-bottom:4px;">● Group 2 → starts at Main 2</div>'
    + '<div id="split-g2-panel" style="min-height:32px;background:#f5f3ff;border:1px dashed #c4b5fd;border-radius:6px;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;"></div></div>'
    + '</div>';

  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'hidden';
  hiddenInput.setAttribute('data-field', 'group1Bunks');
  pickerWrap.appendChild(hiddenInput);

  const updateHidden = () => { hiddenInput.value = JSON.stringify(sortNum([...g1Set])); };

  const renderChips = () => {
    const p1 = pickerWrap.querySelector('#split-g1-panel');
    const p2 = pickerWrap.querySelector('#split-g2-panel');
    p1.innerHTML = ''; p2.innerHTML = '';
    const makeChip = (bunk, inG1) => {
      const c = document.createElement('span');
      c.textContent = bunk;
      c.title = 'Click to move to Group ' + (inG1 ? '2' : '1');
      c.style.cssText = 'cursor:pointer;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:500;user-select:none;'
        + (inG1 ? 'background:#dbeafe;border:1px solid #93c5fd;color:#1e40af;' : 'background:#ede9fe;border:1px solid #c4b5fd;color:#7c3aed;');
      c.addEventListener('click', () => {
        if (inG1) { g1Set.delete(bunk); g2Set.add(bunk); }
        else { g2Set.delete(bunk); g1Set.add(bunk); }
        updateHidden(); renderChips();
      });
      return c;
    };
    sortNum([...g1Set]).forEach(b => p1.appendChild(makeChip(b, true)));
    sortNum([...g2Set]).forEach(b => p2.appendChild(makeChip(b, false)));
  };

  const fieldsContainer = overlay.querySelector('.ms-modal-fields') || overlay.querySelector('[class*="fields"]') || overlay.querySelector('[class*="body"]');
  if (fieldsContainer) fieldsContainer.appendChild(pickerWrap);
  updateHidden(); renderChips();
}

async function editTile(id) {
  const ev = dailySkeleton.find(e => e.id === id);
  if (!ev) return;

  if (ev.type === 'smart') {
    const result = await showModal({
      title: 'Edit Smart Tile',
      fields: [
        { name: 'startTime', label: 'Start Time', type: 'text', default: ev.startTime },
        { name: 'endTime', label: 'End Time', type: 'text', default: ev.endTime },
        { name: 'main1', label: 'Main 1 (limited capacity)', type: 'text', default: ev.smartData?.main1 || '', placeholder: 'e.g., Special, Swim — or a specific one: Lake' },
        { name: 'main2', label: 'Main 2 (everyone else)', type: 'text', default: ev.smartData?.main2 || '', placeholder: 'e.g., Sports, Activity — or specific: Pickleball' },
        { name: 'fallbackActivity', label: 'Fallback', type: 'text', default: ev.smartData?.fallbackActivity || 'Activity', placeholder: 'e.g., Activity, Sports — or specific: Pickleball' },
        { name: 'pairGroup', label: 'Connect with (pair group)', type: 'select', default: ev.smartData?.pairGroup || '', options: [{ value: '', label: 'Auto — pair by time order' }, { value: '1', label: '🔶 Group 1' }, { value: '2', label: '🔷 Group 2' }, { value: '3', label: '🟩 Group 3' }, { value: '4', label: '🟪 Group 4' }] }
      ],
      postRender: (overlay) => { _mbSmartSwapPostRender(overlay, !!(ev.smartData && ev.smartData.guaranteeSwap)); _mbInjectDeleteButton(overlay, ev.id); }
    });
    if (!result || !result.main1 || !result.main2) return;
    const _gsOn = result.guaranteeSwap === 'true';
    ev.startTime = result.startTime; ev.endTime = result.endTime;
    ev.event = `${result.main1} / ${result.main2}`;
    ev.smartData = { main1: result.main1, main2: result.main2, fallbackFor: result.main1, fallbackActivity: _gsOn ? result.main2 : (result.fallbackActivity || 'Activity'), guaranteeSwap: _gsOn, pairGroup: result.pairGroup || null };

  } else if (ev.type === 'split') {
    const [m1 = '', m2 = ''] = ev.event.split(' / ');
    const _editDivName = ev.division;
    const _editExistingG1 = ev.group1Bunks || null;
    const result = await showModal({
      title: 'Edit Split Tile',
      fields: [
        { name: 'startTime', label: 'Start Time', type: 'text', default: ev.startTime },
        { name: 'endTime', label: 'End Time', type: 'text', default: ev.endTime },
        { name: 'main1', label: 'Main 1 (Group 1)', type: 'text', default: m1.trim() },
        { name: 'main2', label: 'Main 2 (Group 2)', type: 'text', default: m2.trim() }
      ],
      postRender: function(overlay) { _buildSplitBunkPicker(overlay, _editDivName, _editExistingG1); }
    });
    if (!result || !result.main1 || !result.main2) return;
    const event1 = mapEventNameForOptimizer(result.main1);
    const event2 = mapEventNameForOptimizer(result.main2);
    ev.startTime = result.startTime; ev.endTime = result.endTime;
    ev.event = `${result.main1} / ${result.main2}`;
    ev.subEvents = [{ ...event1, event: event1.event || result.main1 }, { ...event2, event: event2.event || result.main2 }];
    ev.group1Bunks = result.group1Bunks ? JSON.parse(result.group1Bunks) : null;

  } else if (ev.type === 'elective') {
    const locations = getAllLocations();
    const taken = getConflictingFacilities(ev.startTime, ev.endTime, ev.id);
    const sportMap = getSportFacilitiesMap();
    const sportOptions = [{ value: '', label: '— Pick a sport to auto-assign facility —' }, ...Object.keys(sportMap).sort().map(s => ({ value: s, label: s }))];
    const locationOptions = locations.map(l => (taken.has(l) && !(ev.electiveActivities || []).includes(l)) ? { value: l, label: l, disabled: true, disabledReason: 'Already reserved at this time' } : l);
    const result = await showModal({
      title: 'Edit Elective',
      fields: [
        { name: 'startTime', label: 'Start Time', type: 'text', default: ev.startTime },
        { name: 'endTime', label: 'End Time', type: 'text', default: ev.endTime },
        ...(sportOptions.length > 1 ? [{ name: 'sport', label: 'Sport (auto-assign facility)', type: 'select', options: sportOptions }] : []),
        { name: 'activities', label: 'Reserve Locations', type: 'checkbox-group', options: locationOptions, default: ev.electiveActivities || [] }
      ],
      postRender: (overlay) => {
        const sportSel = overlay.querySelector('[data-field="sport"]');
        if (!sportSel) return;
        sportSel.addEventListener('change', () => {
          const s = sportSel.value;
          const matching = s ? (sportMap[s] || []) : [];
          overlay.querySelectorAll('input[data-group="activities"]:not(:disabled)').forEach(cb => {
            cb.checked = matching.includes(cb.value);
          });
        });
      }
    });
    if (!result) return;
    let chosen = result.activities || [];
    if (result.sport && chosen.length === 0) chosen = (sportMap[result.sport] || []).filter(f => !taken.has(f));
    if (!chosen.length) return;
    ev.startTime = result.startTime; ev.endTime = result.endTime;
    ev.event = 'Elective';
    ev.electiveActivities = chosen; ev.reservedFields = chosen;

  } else if (ev.type === 'swim_elective') {
    const seLocations = getAllLocations();
    let seDefaultPool = ev.swimLocation || window.getPinnedTileDefaultLocation?.('swim') || null;
    if (!seDefaultPool) {
      const _gs = window.loadGlobalSettings?.() || {};
      const _f = (_gs.app1?.fields || []).find(f => /\b(swim|pool)\b/i.test(f.name));
      if (_f) seDefaultPool = _f.name;
    }
    const seTaken = getConflictingFacilities(ev.startTime, ev.endTime, ev.id);
    const seSportMap = getSportFacilitiesMap();
    const seSportOptions = [{ value: '', label: '— Pick a sport to auto-assign facility —' }, ...Object.keys(seSportMap).sort().map(s => ({ value: s, label: s }))];
    const seLocOptions = seLocations
      .filter(l => l !== seDefaultPool)
      .map(l => (seTaken.has(l) && !(ev.electiveActivities || []).includes(l)) ? { value: l, label: l, disabled: true, disabledReason: 'Already reserved at this time' } : l);
    const result = await showModal({
      title: 'Edit Swim + Elective',
      description: 'Hybrid: pool reserved + listed activities reserved at the same time. Campers choose individually.',
      fields: [
        { name: 'startTime', label: 'Start Time', type: 'text', default: ev.startTime },
        { name: 'endTime', label: 'End Time', type: 'text', default: ev.endTime },
        { name: 'preChangeMin', label: 'Pre-Change (minutes, optional)', type: 'text', default: ev._preChangeMin || '' },
        { name: 'postChangeMin', label: 'Post-Change (minutes, optional)', type: 'text', default: ev._postChangeMin || '' },
        ...(seSportOptions.length > 1 ? [{ name: 'sport', label: 'Sport (auto-assign facility)', type: 'select', options: seSportOptions }] : []),
        { name: 'activities', label: 'Reserve Locations (electives)', type: 'checkbox-group', options: seLocOptions, default: ev.electiveActivities || [] }
      ],
      postRender: (overlay) => {
        const sportSel = overlay.querySelector('[data-field="sport"]');
        if (!sportSel) return;
        sportSel.addEventListener('change', () => {
          const s = sportSel.value;
          const matching = s ? (seSportMap[s] || []) : [];
          overlay.querySelectorAll('input[data-group="activities"]:not(:disabled)').forEach(cb => {
            cb.checked = matching.includes(cb.value);
          });
        });
      }
    });
    if (!result) return;
    let seChosen = result.activities || [];
    if (result.sport && seChosen.length === 0) seChosen = (seSportMap[result.sport] || []).filter(f => !seTaken.has(f) && f !== seDefaultPool);
    if (!seChosen.length) {
      await showAlert('Pick at least one elective activity to reserve.');
      return;
    }
    const sePre = parseInt(result.preChangeMin) || 0;
    const sePost = parseInt(result.postChangeMin) || 0;
    ev.startTime = result.startTime; ev.endTime = result.endTime;
    ev.event = 'Swim + Elective';
    ev._preChangeMin = sePre || undefined;
    ev._postChangeMin = sePost || undefined;
    ev.swimLocation = seDefaultPool;
    ev.electiveActivities = seChosen;
    ev.reservedFields = Array.from(new Set([...(seDefaultPool ? [seDefaultPool] : []), ...seChosen]));

  } else {
    const { groups: locationGroups, hasAny: hasLocations } = getGroupedLocationOptions();
    const modalFields = [
      { name: 'eventName', label: 'Event Name', type: 'text', default: ev.event },
      { name: 'startTime', label: 'Start Time', type: 'text', default: ev.startTime },
      { name: 'endTime', label: 'End Time', type: 'text', default: ev.endTime }
    ];
    if (ev.type === 'league' || ev.type === 'specialty_league') {
      const _gs = window.loadGlobalSettings?.() || {};
      const _lbn = _gs.leaguesByName || {};
      // Leagues assigned to this event's grade — specialty tiles list specialty
      // leagues, regular tiles list regular leagues.
      const _gradeLeagues = _mbLeaguesForGradeByType(ev.division, ev.type);
      if (_gradeLeagues.length === 1) {
        // Single league for this grade → assign silently, no picker.
        if (ev.leagueName !== _gradeLeagues[0]) {
          ev.leagueName = _gradeLeagues[0];
          if (ev.event && (ev.event === 'League Game' || _lbn[ev.event])) ev.event = _gradeLeagues[0];
        }
      } else if (_gradeLeagues.length > 1) {
        modalFields.splice(1, 0, {
          name: 'leagueName', label: 'Which League? (required)', type: 'select',
          options: [{ value: '', label: '— Choose a league —' }].concat(_gradeLeagues.map(ln => ({ value: ln, label: ln }))),
          default: _gradeLeagues.includes(ev.leagueName) ? ev.leagueName : ''
        });
      }
    }
    if (hasLocations) {
      modalFields.push({ name: 'reservedFields', label: 'Reserve Locations (optional)', type: 'grouped-checkbox', groups: locationGroups, default: ev.reservedFields || [] });
    }
    const _supportsAway = _mbTileSupportsAway(ev);
    const result = await showModal({ title: 'Edit Event', fields: modalFields, postRender: _supportsAway ? (ov) => _mbAwayPostRender(ov, ev) : undefined });
    if (!result || !result.eventName?.trim()) return;
    const reservedFields = result.reservedFields || [];
    ev.event = result.eventName.trim(); ev.startTime = result.startTime; ev.endTime = result.endTime;
    ev.reservedFields = reservedFields;
    ev.location = reservedFields.length === 1 ? reservedFields[0] : (reservedFields.length > 1 ? null : ev.location);
    if (result.leagueName !== undefined) { ev.leagueName = result.leagueName; if (result.leagueName) ev.event = result.leagueName; }
    // ★ Away (off-campus) flag — restricts generation to the chosen zone's fields + travel.
    if (_supportsAway) {
      const _awayOn = (result.isAway === 'true' || result.isAway === true);
      if (_awayOn && result.awayZone) {
        ev.isAway = true; ev.awayZone = result.awayZone;
        ev.awayMode = (result.awayMode === 'mixed') ? 'mixed' : 'exclusive';
      } else { delete ev.isAway; delete ev.awayZone; delete ev.awayMode; }
    }
  }

  // Re-stamp travel info. An Away tile draws travel straight from its chosen
  // off-campus zone (the actual field is decided at generation time); otherwise
  // travel is inferred from the tile's reserved location/field.
  if (ev.isAway && ev.awayZone) {
    const _az = (window.getAwayZones?.() || []).find(z => z.name === ev.awayZone);
    if (_az && _az.travelTimeMin > 0) {
      ev._travelPre = _az.travelTimeMin;
      ev._travelPost = _az.travelTimeMin;
      ev._travelZone = _az.name;
      ev._travelMode = 'deduct';
    } else {
      delete ev._travelPre; delete ev._travelPost; delete ev._travelZone; delete ev._travelMode;
    }
  } else {
    const _editTravelLoc = ev.location || (Array.isArray(ev.reservedFields) && ev.reservedFields[0]) || '';
    if (_editTravelLoc) {
      const _eti = window.getTravelForField?.(_editTravelLoc, true) || window.getTravelForSpecialActivity?.(_editTravelLoc, true);
      if (_eti) {
        ev._travelPre = _eti.preMin;
        ev._travelPost = _eti.postMin;
        ev._travelZone = _eti.zoneName;
        ev._travelMode = _eti.mode;
      } else {
        delete ev._travelPre; delete ev._travelPost; delete ev._travelZone; delete ev._travelMode;
      }
    } else {
      delete ev._travelPre; delete ev._travelPost; delete ev._travelZone; delete ev._travelMode;
    }
  }

  markUnsavedChanges();
  saveDraftToLocalStorage();
  renderGrid();
}

async function copyTile(id) {
  const ev = dailySkeleton.find(e => e.id === id);
  if (!ev) return;
  const others = getColumnOrder().filter(d => d !== ev.division);
  if (others.length === 0) { await showAlert('No other grades to copy to.'); return; }
  const result = await showModal({
    title: 'Copy Tile to Grades',
    description: `Copy "${ev.event}" (${ev.startTime}–${ev.endTime}) to:`,
    fields: [{ name: 'targets', label: 'Select target grades', type: 'checkbox-group', options: others }]
  });
  if (!result || !result.targets?.length) return;
  result.targets.forEach(div => {
    dailySkeleton.push({ ...ev, id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 5), division: div });
  });
  markUnsavedChanges();
  saveDraftToLocalStorage();
  renderGrid();
}

// --- Render Toolbar ---
function renderToolbar() {
  const toolbar = document.getElementById('scheduler-toolbar');
  if (!toolbar) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  const loadOptions = names.map(n => `<option value="${n}">${n}</option>`).join('');
  const assignments = window.getSkeletonAssignments?.() || {};
  
  // Get today's day name
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; 
  if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = dayNames[dow];
  
  // Get the default template for today
  const todayDefault = assignments[todayName] || assignments["Default"] || null;
  
  // If no template is explicitly loaded but there's a default, use that as current
  const effectiveTemplate = currentLoadedTemplate || todayDefault;
  const isFromDefault = !currentLoadedTemplate && todayDefault;
  
  const canUpdate = !!effectiveTemplate;
  const statusClass = hasUnsavedChanges ? 'has-changes' : '';
  
  // Status text logic
  let statusText;
  let statusSubtext = '';
  if (currentLoadedTemplate) {
    statusText = currentLoadedTemplate;
  } else if (todayDefault) {
    statusText = todayDefault;
    statusSubtext = `<span style="font-size:10px;color:#64748b;margin-left:4px;">(${todayName} default)</span>`;
  } else {
    statusText = 'No Template';
  }
  
  const changesBadge = hasUnsavedChanges ? '<span class="ms-status-badge">Unsaved</span>' : '';
  
  toolbar.innerHTML = `
    <!-- Status + Update -->
    <div class="ms-toolbar-group status ${statusClass}">
      <span class="ms-status-label">Current:</span>
      <span class="ms-status-name">${statusText}</span>${statusSubtext}
      ${changesBadge}
    </div>
    <button id="tb-update-btn" class="ms-btn ms-btn-success" ${!canUpdate ? 'disabled' : ''}>
      Update
    </button>
    
    <!-- Load Template -->
    <div class="ms-toolbar-group">
      <span class="ms-toolbar-label">Load:</span>
      <select id="tb-load-select" class="ms-select">
        <option value="">Select...</option>
        ${loadOptions}
      </select>
    </div>
    
    <!-- New + Save -->
    <div class="ms-toolbar-group">
      <span class="ms-toolbar-label">New:</span>
      <input type="text" id="tb-save-name" class="ms-input" placeholder="Template name...">
      <button id="tb-save-btn" class="ms-btn ms-btn-primary">Save</button>
    </div>
    
    <!-- Clear -->
    <button id="tb-clear-btn" class="ms-btn ms-btn-warning ms-btn-icon" title="Clear Grid">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      Clear
    </button>
    
    <!-- Delete -->
    <div class="ms-toolbar-group" style="border-right:none;">
      <select id="tb-delete-select" class="ms-select" style="min-width:110px;">
        <option value="">Delete...</option>
        ${loadOptions}
      </select>
      <button id="tb-delete-btn" class="ms-btn ms-btn-danger ms-btn-icon" title="Delete Template">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>

    <!-- Copy Grade -->
    <div class="ms-toolbar-group" style="border-right:none;">
      <button id="tb-copy-grade-btn" class="ms-btn ms-btn-ghost" title="Copy schedule from one grade to others">
        Copy Grade
      </button>
    </div>
  `;
  
  // Bindings
  document.getElementById('tb-load-select').onchange = async function() {
    const name = this.value;
    if (name && saved[name]) {
      const ok = await showConfirm(`Load "${name}"?`);
      if (ok) {
        loadSkeletonToBuilder(name);
      }
    }
    this.value = '';
  };
  
  document.getElementById('tb-update-btn').onclick = async () => {
    const templateToUpdate = currentLoadedTemplate || todayDefault;
    if (!templateToUpdate) return;
    if (!window.AccessControl?.checkSetupAccess('update schedule templates')) return;
    
    const ok = await showConfirm(`Overwrite "${templateToUpdate}" with current grid?`);
    if (ok) {
      window.saveSkeleton?.(templateToUpdate, dailySkeleton);
      { const g = window.loadGlobalSettings?.() || {}; if (!g.app1) g.app1 = {}; if (!g.app1.skeletonColumnOrders) g.app1.skeletonColumnOrders = {}; g.app1.skeletonColumnOrders[templateToUpdate] = getColumnOrder(); window.saveGlobalSettings?.('app1', g.app1); }
      window.forceSyncToCloud?.();
      currentLoadedTemplate = templateToUpdate; // Set it as explicitly loaded now
      hasUnsavedChanges = false;
      clearDraftFromLocalStorage();
      await showAlert('Template updated successfully.');
      renderToolbar();
    }
  };
  
  document.getElementById('tb-save-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('save schedule templates')) return;
    
    const name = document.getElementById('tb-save-name').value.trim();
    if (!name) {
      await showAlert('Please enter a template name.');
      return;
    }
    
    if (saved[name]) {
      const ok = await showConfirm(`"${name}" already exists. Overwrite?`);
      if (!ok) return;
    }
    
    window.saveSkeleton?.(name, dailySkeleton);
    { const g = window.loadGlobalSettings?.() || {}; if (!g.app1) g.app1 = {}; if (!g.app1.skeletonColumnOrders) g.app1.skeletonColumnOrders = {}; g.app1.skeletonColumnOrders[name] = getColumnOrder(); window.saveGlobalSettings?.('app1', g.app1); }
    window.forceSyncToCloud?.();
    currentLoadedTemplate = name;
    hasUnsavedChanges = false;
    clearDraftFromLocalStorage();
    await showAlert('Template saved.');
    document.getElementById('tb-save-name').value = '';
    renderToolbar();
    renderExpandSection();
  };
  
  document.getElementById('tb-clear-btn').onclick = async () => {
    const ok = await showConfirm('Clear grid and start new?');
    if (ok) {
      dailySkeleton = [];
      currentLoadedTemplate = null;
      hasUnsavedChanges = false;
      clearDraftFromLocalStorage();
      renderGrid();
      renderToolbar();
    }
  };
  
  document.getElementById('tb-delete-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('delete schedule templates')) return;

    const nameToDelete = document.getElementById('tb-delete-select').value;
    if (!nameToDelete) {
      await showAlert('Please select a template to delete.');
      return;
    }

    const ok = await showConfirm(`Permanently delete "${nameToDelete}"?`);
    if (ok) {
      if (window.deleteSkeleton) {
        window.deleteSkeleton(nameToDelete);
        window.forceSyncToCloud?.();

        if (currentLoadedTemplate === nameToDelete) {
          currentLoadedTemplate = null;
          dailySkeleton = [];
          hasUnsavedChanges = false;
          clearDraftFromLocalStorage();
          renderGrid();
        }

        await showAlert('Template deleted.');
        renderToolbar();
        renderExpandSection();
      }
    }
  };

  document.getElementById('tb-copy-grade-btn').onclick = () => {
    showCopyGradeModal(dailySkeleton, (updated) => {
      dailySkeleton = updated;
      hasUnsavedChanges = true;
      saveDraftToLocalStorage();
      renderGrid();
      renderToolbar();
    });
  };
}


// =================================================================
// DAW (Digital Audio Workstation) LAYER VIEW
// =================================================================
const DAW_LAYER_TYPES = [
  { type:'sport', name:'Sport', style:'background:#86efac;color:#14532d;' },
  { type:'special', name:'Special Activity', style:'background:#c4b5fd;color:#3b1f6b;' },
  { type:'activity', name:'Activity', style:'background:#93c5fd;color:#1e3a5f;' },
  // swim/lunch/snacks are no longer addable as quick layers — they come from
  //   General Activities (facility editor) so their facility config (capacity/
  //   sharing) connects. Kept here (hidden:true) ONLY so legacy saved layers of
  //   these types still render/edit; they're filtered out of the palette + the
  //   type dropdown below.
  { type:'swim', name:'Swim', style:'background:#67e8f9;color:#155e75;', anchor:true, hidden:true },
  { type:'lunch', name:'Lunch', style:'background:#fca5a5;color:#7f1d1d;', anchor:true, hidden:true },
  { type:'snacks', name:'Snacks', style:'background:#fde047;color:#713f12;', anchor:true, hidden:true },
  { type:'dismissal', name:'Dismissal', style:'background:#f87171;color:#fff;', anchor:true },
  { type:'custom', name:'Custom Pinned', style:'background:#d1d5db;color:#374151;', anchor:true },
  { type:'league', name:'League Game', style:'background:#a5b4fc;color:#312e81;' },
  { type:'elective', name:'Elective', style:'background:#f0abfc;color:#701a75;' },
];

const DAW_PIXELS_PER_MINUTE = 3;
let dawLayers = {}; // { gradeKey: [{ id, type, startMin, endMin, qty, op }] }
// ★ Day 24: the layer set used by the most recent renderDAWGrid call —
//   `dawLayers` in the standalone master view, but the externalLayers arg in
//   the Daily Adjustments auto view. openAutoBunkOverridesPanel reads this so
//   the "Bunks" override panel finds the grade's layers in BOTH contexts.
let _lastDAWLayerSource = null;
let dawSelectedBand = null;
let dawDragData = null;

function loadDAWLayers() {
  const g = window.loadGlobalSettings?.() || {};
  const autoTemplates = g.app1?.autoLayerTemplates || {};
  const assignments = window.getSkeletonAssignments?.() || {};
  
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const today = dayNames[dow];
  
  // Figure out which template is assigned to today
  let tmpl = currentLoadedTemplate || assignments[today] || assignments["Default"];
  
  // Lock the UI onto the assigned template
  if (!currentLoadedTemplate && tmpl) {
      currentLoadedTemplate = tmpl;
  }
  
  // Load the assigned template (or fallback to unsaved draft '_current')
  if (tmpl && autoTemplates[tmpl]) {
      dawLayers = JSON.parse(JSON.stringify(autoTemplates[tmpl]));
      applyTemplatePeriods(tmpl);
  } else if (autoTemplates['_current']) {
      dawLayers = JSON.parse(JSON.stringify(autoTemplates['_current']));
      applyTemplatePeriods('_current');
  } else {
      dawLayers = {};
  }
  
  // If empty, seed from divisions
  if (Object.keys(dawLayers).length === 0) {
    const divisions = window.divisions || {};
    Object.keys(divisions).forEach(d => {
      const div = divisions[d];
      if (div.isParent) return;
      dawLayers[d] = [];
    });
  }
}

function saveDAWLayers(forceTemplateName = null) {
  // Always save as a draft while editing, unless a specific template name is forced (Save/Update)
  const templateKey = forceTemplateName || '_current';
  const g = window.loadGlobalSettings?.() || {};
  if (!g.app1) g.app1 = {};
  if (!g.app1.autoLayerTemplates) g.app1.autoLayerTemplates = {};
  if (!g.app1.autoLayerTemplatePeriods) g.app1.autoLayerTemplatePeriods = {};
  g.app1.autoLayerTemplates[templateKey] = JSON.parse(JSON.stringify(dawLayers));
  g.app1.autoLayerTemplatePeriods[templateKey] = JSON.parse(JSON.stringify(window.campPeriods || {}));
  window.saveGlobalSettings?.('app1', g.app1);
  window.forceSyncToCloud?.();
}

function applyTemplatePeriods(templateName) {
  const g = window.loadGlobalSettings?.() || {};
  const snapshot = g.app1?.autoLayerTemplatePeriods?.[templateName];
  if (!snapshot) return false;
  window.campPeriods = JSON.parse(JSON.stringify(snapshot));
  window.saveGlobalSettings?.('campPeriods', window.campPeriods);
  window.dispatchEvent(new CustomEvent('campistry-periods-changed'));
  return true;
}

function renderDAWPalette() {
  const pal = document.getElementById('daw-palette');
  if (!pal) return;

  const DAW_DOTS = {
    sport: '#22c55e', special: '#8b5cf6', activity: '#3b82f6',
    swim: '#06b6d4', lunch: '#f97316', snacks: '#eab308',
    dismissal: '#ec4899', custom: '#64748b', league: '#ef4444', elective: '#d946ef'
  };

  let html = '';
  DAW_LAYER_TYPES.filter(t => !t.anchor && !t.hidden).forEach(t => {
    html += `<div class="ms-daw-tile" draggable="true" data-type="${t.type}">
      <span class="ms-daw-tile-dot" style="background:${DAW_DOTS[t.type] || '#64748b'};"></span>
      <span class="ms-daw-tile-name">${t.name}</span>
    </div>`;
  });

  DAW_LAYER_TYPES.filter(t => t.anchor && !t.hidden).forEach(t => {
    html += `<div class="ms-daw-tile" draggable="true" data-type="${t.type}">
      <span class="ms-daw-tile-dot" style="background:${DAW_DOTS[t.type] || '#64748b'};"></span>
      <span class="ms-daw-tile-name">${t.name}</span>
      <span class="ms-daw-tile-badge">PIN</span>
    </div>`;
  });

  // ★ FN-40: each custom GENERAL ACTIVITY (facility editor → General
  //   Activities) gets its own pinned tile, pre-bound to its facility —
  //   dropping it creates a custom layer with customActivity/customField set
  //   ("Main activity" happens at the Auditorium, like Swim at the Pool).
  const _esc = window.CampUtils?.escapeHtml || (s => String(s));
  const _gaItems = (window.getGeneralActivityPaletteItems?.() || []);
  if (_gaItems.length) {
    html += '<div class="ms-daw-tile-divider"></div><div class="ms-daw-tile-label">General Activities</div>';
    _gaItems.forEach(ga => {
      html += `<div class="ms-daw-tile" draggable="true" data-type="custom" data-ga-name="${_esc(ga.name)}" data-ga-facility="${_esc(ga.facility)}" data-ga-quicktype="${_esc(ga.quickType || 'custom')}" title="${_esc(ga.name + ' @ ' + ga.facility)}">
        <span class="ms-daw-tile-dot" style="background:#d97706;"></span>
        <span class="ms-daw-tile-name">${_esc(ga.name)}</span>
        <span class="ms-daw-tile-badge">PIN</span>
      </div>`;
    });
  }

  html += '<div class="ms-daw-tile-footer"><div class="ms-daw-tile-hint">Drag a layer onto a grade row to place it. Click a band to edit.</div></div>';
  pal.innerHTML = html;

  // Drag from palette
  pal.querySelectorAll('.ms-daw-tile').forEach(tile => {
    tile.addEventListener('dragstart', (e) => {
      dawDragData = { source: 'palette', type: tile.dataset.type, gaName: tile.dataset.gaName || null, gaFacility: tile.dataset.gaFacility || null, gaQuickType: tile.dataset.gaQuicktype || null };
      e.dataTransfer.setData('text/daw-layer', tile.dataset.type);
      // ★ FN-40: carry the general-activity binding alongside the layer type
      //   (incl. quickType so swim/lunch/snacks/dinner apply their behavior).
      if (tile.dataset.gaName) {
        e.dataTransfer.setData('text/daw-ga', JSON.stringify({ name: tile.dataset.gaName, facility: tile.dataset.gaFacility || '', quickType: tile.dataset.gaQuicktype || 'custom' }));
      }
      e.dataTransfer.effectAllowed = 'copy';
      tile.classList.add('ms-daw-tile-dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('ms-daw-tile-dragging'));
  });
}

function renderDAWToolbar() {
  const toolbar = document.getElementById('daw-toolbar');
  if (!toolbar) return;
  
  const g = window.loadGlobalSettings?.() || {};
  const autoTemplates = g.app1?.autoLayerTemplates || {};
  const autoNames = Object.keys(autoTemplates).filter(n => n !== '_current').sort();
  const loadOptions = autoNames.map(n => `<option value="${n}">${n}</option>`).join('');
  
  // Use shared assignments so Manual and Auto refer to the same default days
  const assignments = window.getSkeletonAssignments?.() || {};
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayName = dayNames[dow];
  
  const todayDefault = assignments[todayName] || assignments["Default"] || null;
  const effectiveTemplate = currentLoadedTemplate || todayDefault;
  const canUpdate = !!effectiveTemplate;
  
  let statusText;
  let statusSubtext = '';
  if (currentLoadedTemplate) {
    statusText = currentLoadedTemplate;
  } else if (todayDefault) {
    statusText = todayDefault;
    statusSubtext = `<span style="font-size:10px;color:#64748b;margin-left:4px;">(${todayName} default)</span>`;
  } else {
    statusText = 'No Template';
  }
  
  toolbar.className = 'ms-daw-statusbar';

  const statusDot = hasUnsavedChanges ? '#f59e0b' : (currentLoadedTemplate ? '#22c55e' : '#475569');

  toolbar.innerHTML = `
    <div class="ms-daw-sb-left">
      <span class="ms-daw-status-dot" style="background:${statusDot};box-shadow:0 0 6px ${statusDot};"></span>
      <span class="ms-daw-sb-name">${statusText}${statusSubtext}</span>
    </div>
    <div class="ms-daw-sb-center">
      <select id="daw-load-select" class="ms-daw-sb-select">
        <option value="">Load template…</option>
        ${loadOptions}
      </select>
      <div class="ms-daw-sb-div"></div>
      <button id="daw-update-btn" class="ms-daw-sb-btn ms-daw-sb-accent" ${!canUpdate ? 'disabled' : ''}>Save</button>
      <input type="text" id="daw-save-name" class="ms-daw-sb-input" placeholder="New template name…">
      <button id="daw-save-btn" class="ms-daw-sb-btn ms-daw-sb-accent">Save As</button>
    </div>
    <div class="ms-daw-sb-right">
      <button id="daw-periods-btn" class="ms-daw-sb-btn ms-daw-sb-ghost">Bell Schedule</button>
      <div class="ms-daw-sb-div"></div>
      <button id="daw-copy-btn" class="ms-daw-sb-btn ms-daw-sb-ghost">Copy To…</button>
      <button id="daw-clear-btn" class="ms-daw-sb-btn ms-daw-sb-danger">Clear</button>
      <div class="ms-daw-sb-div"></div>
      <select id="daw-delete-select" class="ms-daw-sb-select">
        <option value="">Delete…</option>
        ${loadOptions}
      </select>
      <button id="daw-delete-btn" class="ms-daw-sb-btn ms-daw-sb-danger">Delete</button>
      <div class="ms-daw-sb-div"></div>
      <button id="daw-fullscreen-btn" class="ms-daw-sb-btn ms-daw-sb-ghost ms-daw-fs-btn" title="Fullscreen">&#9974;</button>
    </div>
  `;
  
  // Bindings
  document.getElementById('daw-load-select').onchange = async function() {
    const name = this.value;
    if (!name) return;
    if (autoTemplates[name]) {
      const ok = await showConfirm(`Load auto template "${name}"?`);
      if (ok) {
        dawLayers = JSON.parse(JSON.stringify(autoTemplates[name]));
        applyTemplatePeriods(name);
        currentLoadedTemplate = name;
        renderDAW();
      }
    }
    this.value = '';
  };
  
  document.getElementById('daw-update-btn').onclick = async () => {
    const templateToUpdate = currentLoadedTemplate || todayDefault;
    if (!templateToUpdate) return;
    if (!window.AccessControl?.checkSetupAccess('update schedule templates')) return;
    
    const ok = await showConfirm(`Overwrite auto layers for "${templateToUpdate}"?`);
    if (ok) {
      saveDAWLayers(templateToUpdate);
      currentLoadedTemplate = templateToUpdate;
      await showAlert('Auto template updated successfully.');
      renderDAWToolbar();
    }
  };
  
  document.getElementById('daw-save-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('save schedule templates')) return;
    
    const name = document.getElementById('daw-save-name').value.trim();
    if (!name) { await showAlert('Enter a template name.'); return; }
    
    if (autoTemplates[name]) {
      const ok = await showConfirm(`"${name}" already exists. Overwrite?`);
      if (!ok) return;
    }
    
    saveDAWLayers(name);
    currentLoadedTemplate = name;
    await showAlert(`Saved auto template "${name}".`);
    document.getElementById('daw-save-name').value = '';
    renderDAWToolbar();
    renderDAWExpandSection();
  };
  
  document.getElementById('daw-clear-btn').onclick = async () => {
    const ok = await showConfirm('Clear all layers from all grades?');
    if (ok) {
      Object.keys(dawLayers).forEach(k => { dawLayers[k] = []; });
      currentLoadedTemplate = null;
      saveDAWLayers();
      renderDAWGrid();
      renderDAWToolbar();
    }
  };
  
  document.getElementById('daw-copy-btn').onclick = () => dawCopyLayersDialog();

  document.getElementById('daw-periods-btn').onclick = () => {
    const panel = document.getElementById('daw-period-panel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      panel.style.display = 'none';
    } else {
      panel.style.display = 'block';
      if (typeof window.PeriodEditor?.renderEditor === 'function') {
        window.PeriodEditor.renderEditor(panel);
      }
    }
  };

  const dawFsBtn = document.getElementById('daw-fullscreen-btn');
  if (dawFsBtn) dawFsBtn.onclick = () => {
    const container = document.querySelector('.ms-container') || document.documentElement;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
      dawFsBtn.innerHTML = '&#x2715;';
      dawFsBtn.title = 'Exit Fullscreen';
    } else {
      document.exitFullscreen();
      dawFsBtn.innerHTML = '&#9974;';
      dawFsBtn.title = 'Fullscreen';
    }
  };
  
  document.getElementById('daw-delete-btn').onclick = async () => {
    if (!window.AccessControl?.checkSetupAccess('delete schedule templates')) return;
    
    const nameToDelete = document.getElementById('daw-delete-select').value;
    if (!nameToDelete) { await showAlert('Please select a template to delete.'); return; }
    
    const ok = await showConfirm(`Permanently delete auto template "${nameToDelete}"?`);
    if (ok) {
      const g2 = window.loadGlobalSettings?.() || {};
      if (g2.app1?.autoLayerTemplates?.[nameToDelete]) {
        delete g2.app1.autoLayerTemplates[nameToDelete];
        if (g2.app1.autoLayerTemplatePeriods) {
          delete g2.app1.autoLayerTemplatePeriods[nameToDelete];
        }
        window.saveGlobalSettings?.('app1', g2.app1);
        window.forceSyncToCloud?.();
        
        if (currentLoadedTemplate === nameToDelete) {
          currentLoadedTemplate = null;
          Object.keys(dawLayers).forEach(k => { dawLayers[k] = []; });
          renderDAWGrid();
        }
        
        await showAlert('Template deleted.');
        renderDAWToolbar();
        renderDAWExpandSection();
      }
    }
  };
}

function renderDAWExpandSection() {
  const expandEl = document.getElementById('daw-expand');
  if (!expandEl) return;
  
  // Combine names from Manual Builder and Auto Builder so assignments sync cleanly
  const manualSaved = window.getSavedSkeletons?.() || {};
  const g = window.loadGlobalSettings?.() || {};
  const autoTemplates = g.app1?.autoLayerTemplates || {};
  
  const allNames = [...new Set([...Object.keys(manualSaved), ...Object.keys(autoTemplates)])]
                    .filter(n => n !== '_current').sort();
                    
  const assignments = window.getSkeletonAssignments?.() || {};
  const loadOptions = allNames.map(n => `<option value="${n}">${n}</option>`).join('');
  
  expandEl.innerHTML = `
    <span class="ms-expand-trigger" onclick="this.nextElementSibling.classList.toggle('open')">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      Day Assignments
    </span>
    <div class="ms-expand-content">
      <div class="ms-assign-grid">
        ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day => `
          <div class="ms-assign-item">
            <label>${day}</label>
            <select data-day="${day}">
              <option value="">None</option>
              ${loadOptions}
            </select>
          </div>
        `).join('')}
      </div>
      <button id="daw-assign-save-btn" class="ms-btn ms-btn-success" style="margin-top:12px;">Save Assignments</button>
    </div>
  `;
  
  expandEl.querySelectorAll('select[data-day]').forEach(sel => {
    sel.value = assignments[sel.dataset.day] || '';
  });
  
  document.getElementById('daw-assign-save-btn').onclick = async () => {
    const map = {};
    expandEl.querySelectorAll('select[data-day]').forEach(s => { 
      if (s.value) map[s.dataset.day] = s.value; 
    });
    window.saveSkeletonAssignments?.(map);
    window.forceSyncToCloud?.();
    await showAlert('Assignments saved.');
    renderToolbar(); // Sync manual toolbar status
    renderDAWToolbar(); // Sync auto toolbar status
  };
}

// ── DAW Constants (module-level so event handlers can access) ──
const DAW_BAND_WIDTH = 40;
const DAW_BAND_GAP = 4;
const DAW_BAND_PAD = 4;
const DAW_GRADE_COL_MIN = 120;
const DAW_NOTCH_DEPTH = 5;
const DAW_NOTCH_HALF = 4;

// Build clip-path polygon with >< notches at period boundaries
function buildNotchClipPath(bandTopPx, bandHeightPx, periodBoundariesPx, bandWidthPx) {
  const notches = periodBoundariesPx
    .map(py => py - bandTopPx)
    .filter(y => y > DAW_NOTCH_HALF + 2 && y < bandHeightPx - DAW_NOTCH_HALF - 2);
  if (notches.length === 0) return '';
  const W = bandWidthPx;
  const right = [];
  const left = [];
  right.push(`${W}px 0px`);
  notches.forEach(y => {
    right.push(`${W}px ${y - DAW_NOTCH_HALF}px`);
    right.push(`${W - DAW_NOTCH_DEPTH}px ${y}px`);
    right.push(`${W}px ${y + DAW_NOTCH_HALF}px`);
  });
  right.push(`${W}px ${bandHeightPx}px`);
  left.push(`0px ${bandHeightPx}px`);
  notches.slice().reverse().forEach(y => {
    left.push(`0px ${y + DAW_NOTCH_HALF}px`);
    left.push(`${DAW_NOTCH_DEPTH}px ${y}px`);
    left.push(`0px ${y - DAW_NOTCH_HALF}px`);
  });
  left.push(`0px 0px`);
  return `clip-path:polygon(${right.join(',')},${left.join(',')});`;
}

function renderDAWGrid(externalEl, externalLayers, externalCallbacks) {
  const gridEl = externalEl || document.getElementById('daw-grid');
  if (!gridEl) return;

  // When called externally (from DA), use provided layers + callbacks
  const isExternal = !!externalEl;
  const layerSource = isExternal ? externalLayers : dawLayers;
  _lastDAWLayerSource = layerSource; // ★ Day 24: remember for openAutoBunkOverridesPanel
  const onChanged = externalCallbacks?.onLayersChanged || null;
  const onSave = isExternal ? (onChanged || function(){}) : saveDAWLayers;
  const onRender = isExternal ? function(){ renderDAWGrid(externalEl, externalLayers, externalCallbacks); } : renderDAWGrid;

  const divisions = window.divisions || {};
  const _gradesRaw = Object.keys(divisions).filter(d => !divisions[d].isParent);
  const grades = (typeof window.getUserDivisionOrder === 'function')
    ? window.getUserDivisionOrder(_gradesRaw)
    : _gradesRaw.sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });

  if (grades.length === 0) {
    gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#8888aa;">No grades configured. Go to Setup to create divisions.</div>';
    return;
  }

  // Find global time bounds dynamically based on divisions
  let globalStart = null, globalEnd = null;
  grades.forEach(g => {
    const div = divisions[g];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
    if (s !== null && (globalStart === null || s < globalStart)) globalStart = s;
    if (e !== null && (globalEnd === null || e > globalEnd)) globalEnd = e;
  });

  // Fallbacks if no times are set
  if (globalStart === null) globalStart = 540; // 9:00 AM
  if (globalEnd === null) globalEnd = 960;     // 4:00 PM

  const totalHeight = (globalEnd - globalStart) * DAW_PIXELS_PER_MINUTE;
  const BAND_WIDTH = DAW_BAND_WIDTH;
  const BAND_GAP = DAW_BAND_GAP;
  const BAND_PAD = DAW_BAND_PAD;
  const GRADE_COL_MIN = DAW_GRADE_COL_MIN;

  let html = '';

  // === VERTICAL LAYOUT: Time on Y-axis, Grades on X-axis ===

  // Grade columns container
  html += `<div class="ms-daw-columns-wrap">`;

  // Collect all unique period boundary times across all grades for the ruler
  const allPeriodTimes = new Set();
  grades.forEach(gk => {
    const gp = (window.campPeriods || {})[gk] || [];
    gp.forEach(p => { allPeriodTimes.add(p.startMin); allPeriodTimes.add(p.endMin); });
  });
  const hasPeriods = allPeriodTimes.size > 0;

  // Build ruler tick times: period boundaries if periods exist, else 30-min intervals
  // Merge times within 10 min of each other → use the latest time (start of next period)
  const rulerTicks = [];
  if (hasPeriods) {
    const sorted = [...allPeriodTimes].filter(m => m >= globalStart && m <= globalEnd).sort((a, b) => a - b);
    const MERGE_MIN = 10; // merge times within 10 minutes
    for (let i = 0; i < sorted.length; i++) {
      let latest = sorted[i];
      while (i + 1 < sorted.length && sorted[i + 1] - sorted[i] <= MERGE_MIN) {
        latest = sorted[++i];
      }
      rulerTicks.push({ min: latest, major: true });
    }
  } else {
    for (let m = globalStart; m < globalEnd; m += 30) {
      rulerTicks.push({ min: m, major: m % 60 === 0 });
    }
  }

  // Time ruler column (fixed left)
  html += `<div class="ms-daw-ruler-col">`;
  // Header spacer to align with grade headers
  html += `<div class="ms-daw-ruler-header-spacer"></div>`;
  // Ruler body
  html += `<div class="ms-daw-ruler-vertical" style="height:${totalHeight}px;">`;
  rulerTicks.forEach(tick => {
    const top = (tick.min - globalStart) * DAW_PIXELS_PER_MINUTE;
    html += `<div class="ms-daw-ruler-tick${tick.major ? ' major-tick' : ''}" style="position:absolute;top:${top}px;">${minutesToTime(tick.min)}</div>`;
  });
  html += `</div></div>`;

  // Grade columns
  grades.forEach(gradeKey => {
    const div = divisions[gradeKey];
    const divStart = parseTimeToMinutes(div?.startTime) || globalStart;
    const divEnd = parseTimeToMinutes(div?.endTime) || globalEnd;
    const bunkCount = (div?.bunks || []).length;
    const layers = layerSource[gradeKey] || [];

    // Column width based on ALL layers
    const layerCount = Math.max(1, layers.length);
    const colWidth = Math.max(GRADE_COL_MIN, layerCount * (BAND_WIDTH + BAND_GAP) + BAND_PAD * 2);

    html += `<div class="ms-daw-grade-col" data-grade="${_mbEsc(gradeKey)}" style="width:${colWidth}px;">`;

    // ── Thin grade header (outside the scrolling track) ──
    // Count bunk overrides for any bunk in this grade so the user knows from
    // the master view that this grade has per-bunk overrides applied.
    let _gradeOvCount = 0;
    try {
      const _dd = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
      const _ovs = _dd?.bunkActivityOverrides || [];
      const _gradeBunks = new Set((div?.bunks || []).map(String));
      _gradeOvCount = _ovs.filter(o => _gradeBunks.has(String(o.bunk))).length;
    } catch(e) {}
    const _ovBadge = _gradeOvCount > 0
      ? ` <span class="ms-daw-grade-ov-badge" title="${_gradeOvCount} bunk override${_gradeOvCount === 1 ? '' : 's'} applied — open Daily Adjustments → Bunk Overrides" style="background:#f59e0b;color:#fff;font-size:9px;font-weight:700;border-radius:99px;padding:1px 5px;margin-left:3px;letter-spacing:0;">⚙ ${_gradeOvCount}</span>`
      : '';
    html += `<div class="ms-daw-grade-header">
      <span class="ms-daw-grade-tag">${_mbEsc(gradeKey)}</span>${_ovBadge}
      <span class="ms-daw-grade-info">${bunkCount} bunks</span>
      <button class="ms-daw-grade-btn" data-action="add-layer" data-grade="${_mbEsc(gradeKey)}" title="Add a new layer to this grade">+</button>
      <button class="ms-daw-grade-btn" data-action="bunk-overrides" data-grade="${_mbEsc(gradeKey)}" title="Override individual bunks' activities (Day 24)">Bunks</button>
      <button class="ms-daw-grade-btn" data-action="clear-grade" data-grade="${_mbEsc(gradeKey)}" title="Remove all layers from this grade">Clear</button>
    </div>`;

    // Collect period boundary pixel positions for this grade (used by notch clip-paths)
    const gradePeriods = (window.campPeriods || {})[gradeKey] || [];
    const periodBoundaryPx = [];
    gradePeriods.forEach(period => {
      const startPx = (period.startMin - globalStart) * DAW_PIXELS_PER_MINUTE;
      const endPx = (period.endMin - globalStart) * DAW_PIXELS_PER_MINUTE;
      if (startPx > 0) periodBoundaryPx.push(startPx);
      if (endPx > 0 && endPx < totalHeight) periodBoundaryPx.push(endPx);
    });
    // Merge boundaries that are within 10min of each other → use the latest (next period start)
    const rawBoundaries = [...new Set(periodBoundaryPx)].sort((a, b) => a - b);
    const MERGE_THRESHOLD = 10 * DAW_PIXELS_PER_MINUTE; // 10 min in px
    const uniqueBoundaries = [];
    for (let i = 0; i < rawBoundaries.length; i++) {
      let latest = rawBoundaries[i];
      while (i + 1 < rawBoundaries.length && rawBoundaries[i + 1] - rawBoundaries[i] <= MERGE_THRESHOLD) {
        latest = rawBoundaries[++i];
      }
      uniqueBoundaries.push(latest);
    }

    // ── Timeline track ──
    html += `<div class="ms-daw-track" data-grade="${_mbEsc(gradeKey)}" data-boundaries="${uniqueBoundaries.join(',')}" style="height:${totalHeight}px;width:100%;position:relative;">`;

    // Horizontal gridlines
    for (let m = globalStart; m < globalEnd; m += 30) {
      const top = (m - globalStart) * DAW_PIXELS_PER_MINUTE;
      const cls = m % 60 === 0 ? 'major' : '';
      html += `<div class="ms-daw-gridline ${cls}" style="top:${top}px;"></div>`;
    }

    // Inactive zones (before div start, after div end)
    if (divStart > globalStart) {
      const h = (divStart - globalStart) * DAW_PIXELS_PER_MINUTE;
      html += `<div class="ms-daw-inactive-zone" style="top:0;height:${h}px;"></div>`;
    }
    if (divEnd < globalEnd) {
      const topPx = (divEnd - globalStart) * DAW_PIXELS_PER_MINUTE;
      const h = (globalEnd - divEnd) * DAW_PIXELS_PER_MINUTE;
      html += `<div class="ms-daw-inactive-zone" style="top:${topPx}px;height:${h}px;"></div>`;
    }

    // Subtle period boundary lines (merged — one line per merged boundary)
    uniqueBoundaries.forEach(py => {
      if (py > 0) {
        html += `<div class="ms-daw-period-line" style="top:${py}px;"></div>`;
      }
    });

    // ★ Day 24: pre-compute per-layer override counts so we can mark each
    //   band with a small icon showing pool/delete/force overrides exist.
    const _gradeOverridesForBand = (() => {
      try {
        const _dd = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
        const _ovs = _dd?.bunkActivityOverrides || [];
        const _bunks = new Set((div?.bunks || []).map(String));
        const byLayer = {};
        _ovs.forEach(o => {
          if (!_bunks.has(String(o.bunk))) return;
          const lt = (o.layerType || 'custom').toLowerCase();
          if (!byLayer[lt]) byLayer[lt] = { pool: 0, delete: 0, force: 0 };
          const m = o.overrideMode || 'force';
          byLayer[lt][m === 'sportPool' ? 'pool' : (m === 'delete' ? 'delete' : 'force')]++;
        });
        return byLayer;
      } catch(e) { return {}; }
    })();

    // Render ALL bands with >< notch clip-paths at period boundaries
    layers.forEach((layer, idx) => {
      const top = (layer.startMin - globalStart) * DAW_PIXELS_PER_MINUTE;
      const height = (layer.endMin - layer.startMin) * DAW_PIXELS_PER_MINUTE;
      const left = BAND_PAD + idx * (BAND_WIDTH + BAND_GAP);
      const opSymbol = layer.op === '=' ? '=' : layer.op === '<=' ? '≤' : '≥';
      const _dMin = Math.min(layer.durationMin || 0, layer.durationMax || 0) || layer.durationMin;
      const _dMax = Math.max(layer.durationMin || 0, layer.durationMax || 0) || layer.durationMax;
      let durLabel = _dMin && _dMax && _dMin !== _dMax
        ? `${_dMin}-${_dMax}m`
        : `${_dMin || layer.periodMin || (layer.endMin - layer.startMin)}m`;
      if (layer.type === 'swim' && (layer.preChangeMin || layer.postChangeMin)) {
        const pre  = layer.preChangeMin  || 0;
        const post = layer.postChangeMin || 0;
        const swimOnly = layer.durationMin || layer.periodMin || ((layer.endMin - layer.startMin) - pre - post);
        durLabel = `${pre}+${swimOnly}+${post}m`;
      }
      const typeDef = DAW_LAYER_TYPES.find(t => t.type === layer.type);
      const clipStyle = buildNotchClipPath(top, height, uniqueBoundaries, BAND_WIDTH);

      // ★ Day 24: per-band override icons (pool / delete / force) so the user
      //   knows AT THE LAYER which bunks have been overridden. Tiny dots in
      //   the top-right corner, stacked.
      const _lt = String(layer.type || '').toLowerCase();
      const _ovInfo = _gradeOverridesForBand[_lt];
      let _ovDots = '';
      if (_ovInfo) {
        const _tip = [];
        if (_ovInfo.pool > 0)   _tip.push(_ovInfo.pool + ' sport pool');
        if (_ovInfo.delete > 0) _tip.push(_ovInfo.delete + ' deleted');
        if (_ovInfo.force > 0)  _tip.push(_ovInfo.force + ' forced');
        const _tipStr = _tip.join(' · ') + ' for this layer (click to open Bunk Overrides)';
        _ovDots = `<div class="ms-daw-band-ov-dots" title="${_tipStr}" style="position:absolute;top:2px;right:2px;display:flex;flex-direction:column;gap:1px;z-index:4;pointer-events:none;">`;
        if (_ovInfo.pool > 0)   _ovDots += `<span style="width:14px;height:14px;border-radius:50%;background:#10b981;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #fff;">${_ovInfo.pool}</span>`;
        if (_ovInfo.force > 0)  _ovDots += `<span style="width:14px;height:14px;border-radius:50%;background:#f59e0b;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #fff;">${_ovInfo.force}</span>`;
        if (_ovInfo.delete > 0) _ovDots += `<span style="width:14px;height:14px;border-radius:50%;background:#64748b;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1.5px #fff;">${_ovInfo.delete}</span>`;
        _ovDots += `</div>`;
      }

      // ★ Grade connection glow: linked custom activities (shared connectionId)
      //   get a colored inner ring + 🔗 marker so the cross-grade "same time"
      //   link is visible. Hue is derived from the group id so groups read apart.
      let _connRing = '', _connClass = '', _connVar = '';
      if (layer.connectionId) {
        _connClass = ' ms-daw-band-connected';
        _connVar = ` --conn-hue:${_dawConnHue(layer.connectionId)};`;
        _connRing = `<div class="ms-daw-band-conn"></div><span class="ms-daw-band-conn-link" title="Connected across grades — scheduled at the same time">🔗</span>`;
      }

      html += `<div class="ms-daw-band${_connClass} ${dawSelectedBand === layer.id ? 'selected' : ''}"
        data-id="${layer.id}" data-type="${layer.type}" data-grade="${_mbEsc(gradeKey)}"${layer.connectionId ? ' data-conn="' + _mbEsc(layer.connectionId) + '"' : ''}
        style="top:${top}px; height:${height}px; left:${left}px; width:${BAND_WIDTH}px;${clipStyle}${_connVar}"
        draggable="true">
        <div class="band-resize band-resize-top"></div>
        ${_connRing}
        <span class="band-label">${_mbEsc(layer.customActivity || layer.leagueName || typeDef?.name || layer.type)}</span>
        <span class="band-qty">${opSymbol}${layer.qty} · ${durLabel}</span>
        ${_ovDots}
        <div class="band-resize band-resize-bottom"></div>
      </div>`;
    });

    html += '</div>'; // track
    html += '</div>'; // grade col
  });

  html += '</div>'; // columns-wrap

  gridEl.innerHTML = html;

  // Bind events (chips + bands + tracks)
  bindDAWEvents(gridEl, globalStart, globalEnd, { layerSource, onSave, onRender, isExternal });

  // ★ Notify external decorators (e.g. daily_adjustments overlays trips on
  //   top of this grid). innerHTML replacement above wipes their DOM — they
  //   listen for this event to re-apply after every render, including
  //   internal redraws triggered by drag/resize that don't go through
  //   onLayersChanged.
  try {
    gridEl.dispatchEvent(new CustomEvent('campistry-daw-rendered', { bubbles: true }));
  } catch (_) {}
}

function bindDAWEvents(gridEl, globalStart, globalEnd, opts) {
  const layerSource = opts?.layerSource || dawLayers;
  const onSave = opts?.onSave || saveDAWLayers;
  const onRender = opts?.onRender || renderDAWGrid;
  const isExternal = opts?.isExternal || false;

  // Click on band to select/edit
  gridEl.querySelectorAll('.ms-daw-band').forEach(band => {
    band.addEventListener('click', (e) => {
      if (e.target.classList.contains('band-resize')) return;
      const id = band.dataset.id;
      const grade = band.dataset.grade;
      dawSelectedBand = dawSelectedBand === id ? null : id;

      // Remove existing popovers
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());

      if (dawSelectedBand) {
        const layer = (layerSource[grade] || []).find(l => l.id === id);
        if (layer) showDAWPopover(band, layer, grade, { onSave, onRender, layerSource });
      }

      // Update selection styling
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      if (dawSelectedBand) band.classList.add('selected');
    });

    // Drag existing band to reposition (vertical) — with smooth ghost +
    // live drop-preview rectangle (parity with manual-builder skeleton tiles).
    band.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('band-resize')) { e.preventDefault(); return; }
      const id = band.dataset.id;
      const grade = band.dataset.grade;
      const layer = (layerSource[grade] || []).find(l => l.id === id);
      if (!layer) return;

      const rect = band.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const offsetMin = Math.round(clickY / DAW_PIXELS_PER_MINUTE);
      dawDragData = { source: 'band', id, grade, layer, offsetMin };

      e.dataTransfer.setData('text/daw-band-move', id);
      e.dataTransfer.effectAllowed = 'copyMove';

      // Hide the browser's native drag preview — we draw our own ghost.
      const _blank = new Image();
      _blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(_blank, 0, 0);

      // Create / reuse a floating ghost tooltip on body.
      let ghost = document.getElementById('daw-drag-ghost');
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.id = 'daw-drag-ghost';
        ghost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;'
          + 'background:#1e293b;color:#f1f5f9;border:1px solid #334155;'
          + 'border-radius:6px;padding:6px 10px;font-size:11px;font-weight:600;'
          + 'box-shadow:0 8px 24px rgba(0,0,0,0.35);display:none;white-space:nowrap;';
        document.body.appendChild(ghost);
      }
      const typeDef = DAW_LAYER_TYPES.find(t => t.type === layer.type);
      ghost.innerHTML = '<div>' + _mbEsc(layer.customActivity || typeDef?.name || layer.type) + '</div>'
        + '<div id="daw-drag-ghost-time" style="font-weight:400;color:#94a3b8;margin-top:2px;">'
        + minutesToTime(layer.startMin) + ' – ' + minutesToTime(layer.endMin) + '</div>';
      ghost.style.display = 'block';
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY + 12) + 'px';

      band.style.opacity = '0.35';
    });

    band.addEventListener('drag', (e) => {
      // The terminal (0,0) drag event fires once when the user releases —
      // ignore it so the ghost doesn't snap to the corner.
      if (e.clientX === 0 && e.clientY === 0) return;
      const ghost = document.getElementById('daw-drag-ghost');
      if (ghost && ghost.style.display === 'block') {
        ghost.style.left = (e.clientX + 12) + 'px';
        ghost.style.top = (e.clientY + 12) + 'px';
      }
    });

    band.addEventListener('dragend', () => {
      band.style.opacity = '1';
      const ghost = document.getElementById('daw-drag-ghost');
      if (ghost) ghost.style.display = 'none';
      // Clean up any lingering preview rectangles in tracks.
      gridEl.querySelectorAll('.ms-daw-drop-preview').forEach(el => el.remove());
      gridEl.querySelectorAll('.ms-daw-track.drop-target').forEach(t => t.classList.remove('drop-target'));
      dawDragData = null;
    });

    // Resize handles (top/bottom for vertical layout)
    band.querySelectorAll('.band-resize').forEach(handle => {
      let isResizing = false;
      let startY, startMin, isTop;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        isTop = handle.classList.contains('band-resize-top');
        startY = e.clientY;

        const id = band.dataset.id;
        const grade = band.dataset.grade;
        const layer = (layerSource[grade] || []).find(l => l.id === id);
        if (!layer) return;
        startMin = isTop ? layer.startMin : layer.endMin;

        const onMove = (e2) => {
          if (!isResizing) return;
          const dy = e2.clientY - startY;
          const dMin = Math.round(dy / DAW_PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
          const newMin = startMin + dMin;

          if (isTop) {
            layer.startMin = Math.max(globalStart, Math.min(layer.endMin - 15, newMin));
          } else {
            layer.endMin = Math.min(globalEnd, Math.max(layer.startMin + 15, newMin));
          }

          // Live update position + clip-path (vertical)
          const top = (layer.startMin - globalStart) * DAW_PIXELS_PER_MINUTE;
          const height = (layer.endMin - layer.startMin) * DAW_PIXELS_PER_MINUTE;
          band.style.top = top + 'px';
          band.style.height = height + 'px';
          // Recalculate notch clip-path
          const track = band.closest('.ms-daw-track');
          const boundaries = (track?.dataset.boundaries || '').split(',').filter(Boolean).map(Number);
          const clip = buildNotchClipPath(top, height, boundaries, DAW_BAND_WIDTH);
          band.style.clipPath = clip ? clip.replace('clip-path:', '').replace(';', '') : '';
        };

        const onUp = () => {
          isResizing = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          onSave();
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  });

  // Drop on tracks (palette → track, or band move) — vertical axis
  gridEl.querySelectorAll('.ms-daw-track').forEach(track => {
    track.addEventListener('dragover', (e) => {
      const isDawDrop = e.dataTransfer.types.includes('text/daw-layer') || e.dataTransfer.types.includes('text/daw-band-move');
      if (!isDawDrop) return;
      e.preventDefault();
      // Cross-grade band drag = copy, same-grade = move, palette = copy
      if (e.dataTransfer.types.includes('text/daw-band-move') && dawDragData) {
        e.dataTransfer.dropEffect = (dawDragData.grade === track.dataset.grade) ? 'move' : 'copy';
      } else {
        e.dataTransfer.dropEffect = 'copy';
      }
      // ★ Tighten column snap visual: clear stale highlights from sibling tracks
      //   so only ONE column ever shows as drop-target at a time. Without this
      //   slow dragover firing on multiple tracks (e.g. via overlap during a
      //   cross-grade drift) could leave more than one column highlighted and
      //   the user couldn't tell which grade would actually receive the drop.
      gridEl.querySelectorAll('.ms-daw-track.drop-target').forEach(t => {
        if (t !== track) t.classList.remove('drop-target');
      });
      track.classList.add('drop-target');
      // Surface the target grade name as a tiny pill at the top of the track
      //   so the user can confirm before releasing.
      if (!track.querySelector('.ms-daw-snap-badge')) {
        const badge = document.createElement('div');
        badge.className = 'ms-daw-snap-badge';
        badge.style.cssText = 'position:absolute;top:2px;left:50%;transform:translateX(-50%);'
          + 'background:#3b82f6;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;'
          + 'border-radius:10px;pointer-events:none;z-index:10;white-space:nowrap;';
        badge.textContent = '↓ ' + (track.dataset.grade || '');
        track.appendChild(badge);
      }

      // ★ Live drop preview — shows where the band will land at this moment.
      //   Reuses one preview element per track so we don't spam the DOM.
      if (dawDragData?.source === 'band' && dawDragData.layer) {
        const trackRect = track.getBoundingClientRect();
        const y = e.clientY - trackRect.top;
        const dropMin = Math.round((y / DAW_PIXELS_PER_MINUTE + globalStart) / SNAP_MINS) * SNAP_MINS;
        const duration = dawDragData.layer.endMin - dawDragData.layer.startMin;
        let newStart = dropMin - dawDragData.offsetMin;
        newStart = Math.max(globalStart, Math.min(globalEnd - duration, newStart));
        const newEnd = newStart + duration;

        let preview = track.querySelector('.ms-daw-drop-preview');
        if (!preview) {
          preview = document.createElement('div');
          preview.className = 'ms-daw-drop-preview';
          preview.style.cssText = 'position:absolute;left:0;right:0;'
            + 'background:rgba(59,130,246,0.18);border:2px dashed #3b82f6;'
            + 'border-radius:4px;pointer-events:none;z-index:7;'
            + 'display:flex;align-items:flex-start;justify-content:center;padding-top:3px;';
          track.appendChild(preview);
        }
        preview.style.top = ((newStart - globalStart) * DAW_PIXELS_PER_MINUTE) + 'px';
        preview.style.height = (duration * DAW_PIXELS_PER_MINUTE) + 'px';
        preview.innerHTML = '<span style="background:#3b82f6;color:#fff;'
          + 'padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;'
          + 'white-space:nowrap;">'
          + minutesToTime(newStart) + ' – ' + minutesToTime(newEnd) + '</span>';

        // Update the floating ghost's time line too.
        const ghostTime = document.getElementById('daw-drag-ghost-time');
        if (ghostTime) ghostTime.textContent = minutesToTime(newStart) + ' – ' + minutesToTime(newEnd);
      }
    });

    track.addEventListener('dragleave', (e) => {
      if (!track.contains(e.relatedTarget)) {
        track.classList.remove('drop-target');
        const preview = track.querySelector('.ms-daw-drop-preview');
        if (preview) preview.remove();
        // ★ Remove snap badge when leaving the column
        const badge = track.querySelector('.ms-daw-snap-badge');
        if (badge) badge.remove();
      }
    });

    track.addEventListener('drop', async (e) => {
      e.preventDefault();
      track.classList.remove('drop-target');
      // Remove any drop-preview rectangles so they don't briefly persist
      // before the upcoming re-render replaces the track HTML.
      gridEl.querySelectorAll('.ms-daw-drop-preview').forEach(el => el.remove());
      // ★ Clean snap badges from all tracks on drop
      gridEl.querySelectorAll('.ms-daw-snap-badge').forEach(el => el.remove());

      const grade = track.dataset.grade;
      const rect = track.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const dropMin = Math.round((y / DAW_PIXELS_PER_MINUTE + globalStart) / SNAP_MINS) * SNAP_MINS;

      if (e.dataTransfer.types.includes('text/daw-layer')) {
        // New band from palette
        const type = e.dataTransfer.getData('text/daw-layer');
        const layerDef = DAW_LAYER_TYPES.find(t => t.type === type);
        if (!layerDef) return;

        const div = (window.divisions || {})[grade] || {};
        const divStart = parseTimeToMinutes(div.startTime) || globalStart;
        const divEnd = parseTimeToMinutes(div.endTime) || globalEnd;

        let startMin, endMin;
        if (layerDef.anchor) {
          // Anchors get a fixed 30-min window at drop point
          startMin = Math.max(divStart, dropMin - 15);
          endMin = Math.min(divEnd, startMin + 30);
        } else {
          // Floaters span the full division range
          startMin = divStart;
          endMin = divEnd;
        }

        // ★ Multi-league picker for auto builder: mirrors manual builder
        //   logic. 0 → block, 1 → auto-assign, 2+ → prompt user to pick.
        let _pickedLeague = null;
        if (type === 'league' || type === 'specialty_league') {
          const _gradeLeagues = _mbLeaguesForGradeByType(grade, type);
          if (_gradeLeagues.length === 0) {
            await showAlert('No leagues are assigned to ' + grade +
              '. Add this grade to a league in League Setup before dropping a league layer here.');
            return;
          } else if (_gradeLeagues.length === 1) {
            _pickedLeague = _gradeLeagues[0];
          } else {
            const _pickResult = await showModal({
              title: 'Which League?',
              fields: [{
                name: 'leagueName',
                label: 'Which League? (required)',
                type: 'select',
                options: [{ value: '', label: '— Choose a league —' }]
                  .concat(_gradeLeagues.map(ln => ({ value: ln, label: ln }))),
                default: ''
              }]
            });
            if (!_pickResult || !_pickResult.leagueName) return;
            _pickedLeague = _pickResult.leagueName;
          }
        }

        if (!layerSource[grade]) layerSource[grade] = [];
        const _newLayer = {
          id: 'daw_' + Math.random().toString(36).slice(2, 9),
          type,
          startMin,
          endMin,
          qty: 1,
          op: layerDef.anchor ? '=' : '>=',
          durationMin: layerDef.anchor ? (endMin - startMin) : 30,
          durationMax: layerDef.anchor ? (endMin - startMin) : 50,
          periodMin: layerDef.anchor ? (endMin - startMin) : 30,
        };

        if (_pickedLeague) _newLayer.leagueName = _pickedLeague;

        // ★ FN-40: a general-activity tile drop binds the custom layer to its
        //   activity + facility (the proven customActivity/customField lane).
        if (type === 'custom' && e.dataTransfer.types.includes('text/daw-ga')) {
          try {
            const _ga = JSON.parse(e.dataTransfer.getData('text/daw-ga') || '{}');
            if (_ga && _ga.name) {
              _newLayer.customActivity = _ga.name;
              if (_ga.facility) _newLayer.customField = _ga.facility;
              // ★ Carry quickType so a Swim/Lunch/Snacks/Dinner general activity
              //   applies that behavior in the solver (normalized at STEP 1.5).
              const _qt = String(_ga.quickType || '').toLowerCase();
              if (_qt && _qt !== 'custom') _newLayer.quickType = _qt;
            }
          } catch (_eGa) {}
        }

        layerSource[grade].push(_newLayer);

        onSave();
        onRender();
      }
      else if (e.dataTransfer.types.includes('text/daw-band-move') && dawDragData?.source === 'band') {
        const { id, grade: fromGrade, layer, offsetMin } = dawDragData;
        const duration = layer.endMin - layer.startMin;
        const newStart = Math.round((dropMin - offsetMin) / SNAP_MINS) * SNAP_MINS;
        const newEnd = newStart + duration;

        if (fromGrade !== grade) {
          // Cross-grade drop → COPY the layer to the target grade. For
          //   league layers, remap leagueName to a league assigned to the
          //   target grade so the copy doesn't keep referencing the source
          //   grade's league.
          if (!layerSource[grade]) layerSource[grade] = [];
          const _copyLayer = {
            ...JSON.parse(JSON.stringify(layer)),
            id: 'daw_' + Math.random().toString(36).slice(2, 9),
            startMin: Math.max(globalStart, newStart),
            endMin: Math.min(globalEnd, newEnd),
          };
          // ★ A cross-grade copy must NOT inherit the source's connection group —
          //   the user links grades explicitly via the layer editor.
          delete _copyLayer.connectionId;
          delete _copyLayer._connectionAnchor;
          _mbRemapLeagueForGrade(_copyLayer, grade);
          layerSource[grade].push(_copyLayer);
        } else {
          // Same grade → move in place
          layer.startMin = Math.max(globalStart, newStart);
          layer.endMin = Math.min(globalEnd, newEnd);
        }

        onSave();
        onRender();
      }

      dawDragData = null;
    });
  });
  
  // Grade action buttons
  gridEl.querySelectorAll('[data-action="add-layer"]').forEach(btn => {
    btn.onclick = () => {
      const grade = btn.dataset.grade;
      dawAddLayerDialog(grade);
    };
  });

  gridEl.querySelectorAll('[data-action="clear-grade"]').forEach(btn => {
    btn.onclick = async () => {
      const grade = btn.dataset.grade;
      const ok = await showConfirm(`Clear all layers from ${grade}?`);
      if (ok) {
        layerSource[grade] = [];
        onSave();
        onRender();
      }
    };
  });

  // ★ Day 24: Bunk overrides — open the per-bunk DAW grid for this grade so
  //   the user can override any bunk's activity for any layer slot.
  //   `openAutoBunkOverridesPanel` is module-scope; the click handler is
  //   guarded so a missing function doesn't break the rest of the toolbar.
  gridEl.querySelectorAll('[data-action="bunk-overrides"]').forEach(btn => {
    btn.onclick = () => {
      const grade = btn.dataset.grade;
      if (typeof openAutoBunkOverridesPanel === 'function') {
        openAutoBunkOverridesPanel(grade);
      } else {
        try { (window.showAlert || window.alert)('Bunk overrides panel unavailable.'); } catch (_e) {}
      }
    };
  });
  
  // Click on empty track space to deselect
  gridEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('ms-daw-track') || e.target.classList.contains('ms-daw-gridline')) {
      dawSelectedBand = null;
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
    }
  });
  
  // Keyboard: Delete selected band
  // ★ Use a module-level reference so we can actually remove the previous
  //   handler on re-render. Declaring a fresh closure each call and passing
  //   it to removeEventListener is a no-op — listeners leaked every render.
  if (window._dawKeyHandler) {
    document.removeEventListener('keydown', window._dawKeyHandler);
  }
  window._dawKeyHandler = (e) => {
    if (currentBuilderMode !== 'auto') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && dawSelectedBand) {
      e.preventDefault();
      Object.keys(layerSource).forEach(grade => {
        layerSource[grade] = (layerSource[grade] || []).filter(l => l.id !== dawSelectedBand);
      });
      dawSelectedBand = null;
      onSave();
      onRender();
    }
    if (e.key === 'Escape') {
      dawSelectedBand = null;
      gridEl.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
      gridEl.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
    }
  };
  document.addEventListener('keydown', window._dawKeyHandler);
}

// Resolve the sharing config a general activity was given in the Facilities UI so
//   the layer edit modal pre-fills the SAME capacity + inter-grade-sharing grades —
//   exactly the way name and location already carry over. Returns { capacity,
//   allowedGrades } or null when the activity/facility configures no sharing.
//   The facility stores inter-grade sharing as allowedPairs ("gradeA|gradeB"); the
//   default toggle seeds same-grade self-pairs for ALL grades, so only pairs whose
//   two grades DIFFER represent true inter-grade sharing — those are the grades the
//   modal should pre-check.
function _dawFacilitySharingDefaults(activityName, fieldName) {
  try {
    if (!activityName || typeof window.getCustomActivitySharingInfo !== 'function') return null;
    const gs = (typeof window.loadGlobalSettings === 'function') ? window.loadGlobalSettings() : (window.globalSettings || {});
    const info = window.getCustomActivitySharingInfo(activityName, fieldName || null, null, gs);
    if (!info || info.shareType === 'not_sharable') return null;
    const gset = {};
    const pairs = info.allowedPairs || {};
    Object.keys(pairs).forEach(k => {
      if (!pairs[k]) return;
      const parts = String(k).split('|');
      if (parts.length === 2 && parts[0] !== parts[1]) { gset[parts[0]] = 1; gset[parts[1]] = 1; }
    });
    let allowedGrades = Object.keys(gset);
    if (allowedGrades.length === 0 && Array.isArray(info.allowedDivisions)) {
      allowedGrades = info.allowedDivisions.map(String).filter(Boolean);
    }
    const cap = (info.capacity && isFinite(info.capacity) && info.capacity > 0) ? info.capacity : null;
    if (!cap && allowedGrades.length === 0) return null;
    return { capacity: cap, allowedGrades: allowedGrades };
  } catch (_e) { return null; }
}

// ★ GRADE CONNECTION ("same time across grades"). A connection links the SAME
//   custom activity across several grades so the auto builder places it at the
//   IDENTICAL start time for all of them. Membership is stored as a shared
//   `layer.connectionId` on each grade's matching custom layer.
//
// _dawConnHue(connId)  — deterministic hue (0-359) so each group glows a
//   distinct, stable color across renders.
function _dawConnHue(connId) {
  let h = 0; const s = String(connId || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// _dawApplyGradeConnection — rebuild a connection group from the popover's
//   checked grades. `checkedGrades` is the set of OTHER grades to lock to the
//   same time as `layer` (a custom layer in `grade`). Matching is by activity
//   name; the closest-window layer in each grade is chosen. A resulting group
//   of <2 members is cleared entirely (a link needs two grades).
function _dawApplyGradeConnection(layer, grade, checkedGrades, layerSource) {
  if (!layer || (layer.type || '').toLowerCase() !== 'custom') return;
  const actLow = String(layer.customActivity || '').toLowerCase().trim();
  const oldId = layer.connectionId || null;
  // Tear down any existing group sharing this layer's id, so we rebuild cleanly.
  if (oldId) {
    Object.keys(layerSource).forEach(g => (layerSource[g] || []).forEach(l => {
      if (l && l.connectionId === oldId) delete l.connectionId;
    }));
  }
  const members = [layer];
  if (actLow) {
    (checkedGrades || []).forEach(g => {
      const cands = (layerSource[g] || []).filter(l =>
        l && (l.type || '').toLowerCase() === 'custom' &&
        String(l.customActivity || '').toLowerCase().trim() === actLow);
      if (!cands.length) return;
      cands.sort((a, b) => Math.abs((a.startMin || 0) - (layer.startMin || 0)) - Math.abs((b.startMin || 0) - (layer.startMin || 0)));
      if (members.indexOf(cands[0]) < 0) members.push(cands[0]);
    });
  }
  if (members.length >= 2 && actLow) {
    const id = oldId || ('conn_' + Math.random().toString(36).slice(2, 9));
    members.forEach(l => { l.connectionId = id; });
  }
}

function showDAWPopover(bandEl, layer, grade, opts) {
  const onSave = opts?.onSave || saveDAWLayers;
  const onRender = opts?.onRender || renderDAWGrid;
  const layerSource = opts?.layerSource || dawLayers;
  // Pre-fill sharing from the facility general-activity config when this layer has
  //   no override of its own yet (so the inter-grade-sharing grades show the same
  //   way name/location already do, and a blind Save can't silently clear them).
  const _facShareDef = (layer && layer.type === 'custom' && !layer.customSharing)
    ? _dawFacilitySharingDefaults(layer.customActivity, layer.customField) : null;

  // Remove existing
  document.querySelectorAll('.ms-daw-popover').forEach(p => p.remove());
  // Remove existing overlays too
  document.querySelectorAll('.ms-daw-popover-overlay').forEach(o => o.remove());

  const typeName = DAW_LAYER_TYPES.find(t => t.type === layer.type)?.name || layer.type;
  
  const popover = document.createElement('div');
  popover.className = 'ms-daw-popover';

  const DAW_POP_COLORS = {
    sport: { border: '#16a34a', dot: '#22c55e' },
    special: { border: '#7c3aed', dot: '#8b5cf6' },
    activity: { border: '#2563eb', dot: '#3b82f6' },
    swim: { border: '#0891b2', dot: '#06b6d4' },
    lunch: { border: '#ea580c', dot: '#f97316' },
    snacks: { border: '#d97706', dot: '#eab308' },
    dismissal: { border: '#db2777', dot: '#ec4899' },
    custom: { border: '#475569', dot: '#64748b' },
    league: { border: '#dc2626', dot: '#ef4444' },
    elective: { border: '#c026d3', dot: '#d946ef' }
  };
  const pColor = DAW_POP_COLORS[layer.type] || DAW_POP_COLORS.custom;

  popover.innerHTML = `
    <div class="ms-daw-pop-header" style="background:linear-gradient(135deg,${pColor.border}dd,${pColor.border}99);">
      <span class="ms-daw-pop-header-dot" style="background:${pColor.dot};"></span>
      <div class="ms-daw-pop-header-info">
        <div class="ms-daw-pop-header-name">${typeName}</div>
        <div class="ms-daw-pop-header-type">${layer.type.replace(/_/g,' ')} · ${minutesToTime(layer.startMin)}–${minutesToTime(layer.endMin)}</div>
      </div>
      <button class="ms-daw-pop-close" id="daw-pop-close-x">×</button>
    </div>
    <div class="ms-daw-pop-body">
      <div class="ms-daw-pop-section">Scheduling</div>
      <div class="ms-daw-pop-field">
        <label>Time Window</label>
        <div class="ms-daw-pop-row">
          <input type="text" id="daw-pop-start" value="${minutesToTime(layer.startMin)}" style="flex:1;">
          <span style="color:#94a3b8;">→</span>
          <input type="text" id="daw-pop-end" value="${minutesToTime(layer.endMin)}" style="flex:1;">
        </div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Activity Duration (min)</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-dur-min" value="${layer.durationMin || layer.periodMin || 30}" min="5" max="180" step="5" style="width:70px;">
          <span style="color:#94a3b8;font-size:11px;">to</span>
          <input type="number" id="daw-pop-dur-max" value="${layer.durationMax || layer.periodMin || 50}" min="5" max="180" step="5" style="width:70px;">
          <span style="font-size:11px;color:#94a3b8;">min</span>
        </div>
      </div>
      ${(() => {
        // ★ Special-activity layers use a per-subcategory quantity grid driven
        //   by the registry the user manages in Facilities. Each row's value
        //   is "exactly N from this subcategory" (0 = skip). Total is the sum.
        if (layer.type !== 'special') {
          return `
      <div class="ms-daw-pop-field">
        <label>Quantity</label>
        <div class="ms-daw-pop-row">
          <div style="display:flex;">
            <button class="ms-daw-pop-op ${layer.op === '>=' ? 'active' : ''}" data-op=">=">≥</button>
            <button class="ms-daw-pop-op ${layer.op === '=' ? 'active' : ''}" data-op="=">=</button>
            <button class="ms-daw-pop-op ${layer.op === '<=' ? 'active' : ''}" data-op="<=">≤</button>
          </div>
          <input type="number" id="daw-pop-qty" value="${layer.qty}" min="1" max="10" style="width:60px;">
        </div>
      </div>`;
        }
        const _regSubs = (typeof window.getSpecialSubcategories === 'function')
          ? window.getSpecialSubcategories() : [];
        // Canonicalize: blank + the legacy "Regular" label both collapse to the
        //   implicit "uncategorized" bucket that untagged specials map to.
        const _canonSubName = (s) => { const v = (typeof s === 'string' ? s : '').trim().toLowerCase(); return (!v || v === 'regular' || v === 'uncategorized') ? 'uncategorized' : v; };
        // ★ "Uncategorized" is always present (untagged specials map here); strip any
        //   "Regular"/"Uncategorized" the registry/tags carry so it appears once.
        const subs = ['Uncategorized', ..._regSubs.filter(s => _canonSubName(s) !== 'uncategorized')];
        if (subs.length === 0) {
          return `
      <div class="ms-daw-pop-field">
        <label>Quantity</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-qty" value="${layer.qty}" min="0" max="10" style="width:60px;">
        </div>
        <div class="ms-daw-pop-hint" style="color:#fbbf24;">No subcategories defined yet. Add them in Facilities → Special Activities → Subcategory.</div>
      </div>`;
        }
        // Seed subQuantities. Priority: existing subQuantities → legacy
        // {subcategory + qty} → all-zero defaults.
        const existing = (layer.subQuantities && typeof layer.subQuantities === 'object') ? layer.subQuantities : null;
        const legacySub = (typeof layer.subcategory === 'string') ? layer.subcategory.trim() : '';
        const getSeeded = (name) => {
          const cn = _canonSubName(name);
          if (existing) {
            // Canonical lookup so a legacy {Regular:N} key seeds the Uncategorized row.
            const key = Object.keys(existing).find(k => _canonSubName(k) === cn);
            return key ? (parseInt(existing[key], 10) || 0) : 0;
          }
          if (legacySub && _canonSubName(legacySub) === cn) {
            return parseInt(layer.qty, 10) || 1;
          }
          return 0;
        };
        // Seed each row's operator from layer.subOps (default '=' = exactly).
        const _subOpsSeed = (layer.subOps && typeof layer.subOps === 'object') ? layer.subOps : {};
        const getSeededOp = (name) => {
          const cn = _canonSubName(name);
          const key = Object.keys(_subOpsSeed).find(k => _canonSubName(k) === cn);
          const op = key ? _subOpsSeed[key] : '=';
          return (op === '>=' || op === '<=' || op === '=') ? op : '=';
        };
        const rows = subs.map(name => {
          const v = getSeeded(name);
          const op = getSeededOp(name);
          const sn = name.replace(/"/g, '&quot;');
          return `
          <div class="ms-daw-subq-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
            <span style="font-size:12px;color:#cbd5e1;">${name}</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <div style="display:flex;">
                <button class="ms-daw-pop-op ms-daw-subq-op ${op === '>=' ? 'active' : ''}" data-subname="${sn}" data-op=">=">≥</button>
                <button class="ms-daw-pop-op ms-daw-subq-op ${op === '=' ? 'active' : ''}" data-subname="${sn}" data-op="=">=</button>
                <button class="ms-daw-pop-op ms-daw-subq-op ${op === '<=' ? 'active' : ''}" data-subname="${sn}" data-op="<=">≤</button>
              </div>
              <input type="number" class="ms-daw-subq-input" data-subname="${sn}" value="${v}" min="0" max="10" style="width:60px;">
            </div>
          </div>`;
        }).join('');
        const total = subs.reduce((s, name) => s + getSeeded(name), 0);
        return `
      <div class="ms-daw-pop-field">
        <label>Quantity by Subcategory</label>
        <div style="display:flex;flex-direction:column;gap:2px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:6px 10px;background:rgba(255,255,255,0.03);">
          ${rows}
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#94a3b8;">
            <span>Total</span>
            <span id="daw-pop-subq-total" style="font-weight:600;color:#e2e8f0;">${total}</span>
          </div>
        </div>
        <div class="ms-daw-pop-hint">Per subcategory: ≥ at least · = exactly · ≤ at most. 0 = skip that subcategory. List comes from Facilities → Special Activities → Subcategory.</div>
      </div>`;
      })()}
      ${(layer.type === 'league' || layer.type === 'specialty_league') ? (() => {
        const _gradeLeagues = _mbLeaguesForGradeByType(grade, layer.type);
        if (_gradeLeagues.length <= 1) return ''; // auto-assigned, no picker needed
        return `
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">League</div>
      <div class="ms-daw-pop-field">
        <label>Assigned League</label>
        <div class="ms-daw-pop-row">
          <select id="daw-pop-league-name" style="flex:1;">
            ${_gradeLeagues.map(n => '<option value="' + n + '"' + (n === layer.leagueName ? ' selected' : '') + '>' + n + '</option>').join('')}
          </select>
        </div>
        <div class="ms-daw-pop-hint">This grade has ${_gradeLeagues.length} leagues. Pick which one this layer uses.</div>
      </div>`;
      })() : ''}
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Rotation <span style="font-weight:400;font-size:10px;letter-spacing:0;text-transform:none;color:#cbd5e1;">optional</span></div>
      <div class="ms-daw-pop-field">
        <label>Bunks / Day</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-bpd" value="${layer.bunksPerDay != null ? layer.bunksPerDay : ''}" min="1" max="99" style="width:70px;" placeholder="All">
          <span style="font-size:11px;color:#94a3b8;">per grade</span>
        </div>
        <div class="ms-daw-pop-hint">Max bunks per day — others get it on a different day.</div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Times / Week</label>
        <div class="ms-daw-pop-row">
          <div style="display:flex;">
            <button class="ms-daw-pop-op ms-daw-wop ${(layer.weeklyOp || '>=') === '>=' ? 'active' : ''}" data-wop=">=">≥</button>
            <button class="ms-daw-pop-op ms-daw-wop ${layer.weeklyOp === '=' ? 'active' : ''}" data-wop="=">=</button>
            <button class="ms-daw-pop-op ms-daw-wop ${layer.weeklyOp === '<=' ? 'active' : ''}" data-wop="<=">≤</button>
          </div>
          <input type="number" id="daw-pop-week-qty" value="${layer.timesPerWeek != null ? layer.timesPerWeek : ''}" min="1" max="7" style="width:60px;" placeholder="Any">
          <span style="font-size:11px;color:#94a3b8;">days/wk</span>
        </div>
        <div class="ms-daw-pop-hint">Target days per week each bunk gets this.</div>
      </div>
      ${['swim','lunch','snacks','snack'].includes(layer.type) ? `
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Grade Mode</div>
      <div class="ms-daw-pop-field">
        <label>Scheduling</label>
        <div class="ms-daw-pop-toggle-group">
          <button class="ms-daw-grademode ${!layer.fullGrade ? 'active' : ''}" data-gmode="stagger">Staggered</button>
          <button class="ms-daw-grademode ${layer.fullGrade ? 'active' : ''}" data-gmode="fullgrade">Full Grade</button>
        </div>
        <div class="ms-daw-pop-hint"><b>Full Grade:</b> all bunks at once. <b>Staggered:</b> spread across window.</div>
      </div>
      ` : ''}
      ${layer.type === 'swim' ? `
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Change Time</div>
      <div class="ms-daw-pop-field">
        <label>Pre-Change</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-pre-change" value="${layer.preChangeMin != null ? layer.preChangeMin : ''}" min="0" max="60" step="5" style="width:70px;" placeholder="0">
          <span style="font-size:11px;color:#94a3b8;">min</span>
        </div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Post-Change</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-post-change" value="${layer.postChangeMin != null ? layer.postChangeMin : ''}" min="0" max="60" step="5" style="width:70px;" placeholder="0">
          <span style="font-size:11px;color:#94a3b8;">min</span>
        </div>
        <div class="ms-daw-pop-hint">Size the band to just the swim period. Pre extends backward, post extends to the next period's start (skips gaps).</div>
      </div>
      ` : ''}
      ${layer.type === 'custom' ? `
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Custom Activity</div>
      <div class="ms-daw-pop-field">
        <label>Activity Name</label>
        <div class="ms-daw-pop-row">
          <input type="text" id="daw-pop-custom-name" value="${_mbEsc(layer.customActivity || '')}" placeholder="e.g. Home Run Derby" style="flex:1;">
        </div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Field / Location</label>
        <div class="ms-daw-pop-row">
          <select id="daw-pop-custom-field" style="flex:1;">
            <option value="">-- Select field --</option>
            ${(() => {
              const gs = window.loadGlobalSettings?.() || {};
              const fields = gs.app1?.fields || gs.fields || window.fields || [];
              const specialLocs = (gs.app1?.specialActivities || []).map(s => s.location).filter(Boolean);
              const allLocs = [...new Set([...fields.map(f => f.name), ...specialLocs])].sort();
              return allLocs.map(f => '<option value="' + f + '"' + (f === (layer.customField || '') ? ' selected' : '') + '>' + f + '</option>').join('');
            })()}
            <option value="_custom" ${layer.customField && !(() => { const gs = window.loadGlobalSettings?.() || {}; const fields = gs.app1?.fields || []; return fields.some(f => f.name === layer.customField); })() ? 'selected' : ''}>-- Custom location --</option>
          </select>
        </div>
      </div>
      <div id="daw-pop-custom-field-text-wrap" style="display:${layer.customField && !(() => { const gs = window.loadGlobalSettings?.() || {}; const fields = gs.app1?.fields || []; return fields.some(f => f.name === layer.customField); })() ? 'block' : 'none'};">
        <div class="ms-daw-pop-row">
          <input type="text" id="daw-pop-custom-field-text" value="${layer.customField || ''}" placeholder="Type location name" style="flex:1;">
        </div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Bunks</label>
        <div class="ms-daw-pop-row" style="flex-wrap:wrap;gap:4px;">
          <button id="daw-pop-bunk-all" style="font-size:10px;padding:3px 8px;border:1px solid rgba(255,255,255,0.12);border-radius:4px;background:rgba(255,255,255,0.08);color:#94a3b8;cursor:pointer;font-weight:600;">All</button>
          <button id="daw-pop-bunk-none" style="font-size:10px;padding:3px 8px;border:1px solid rgba(255,255,255,0.12);border-radius:4px;background:rgba(255,255,255,0.08);color:#94a3b8;cursor:pointer;font-weight:600;">None</button>
        </div>
        <div id="daw-pop-bunk-grid" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
          ${(() => {
            const divs = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
            const bunks = (divs[grade]?.bunks || []).map(String);
            const selected = layer.customBunks || bunks;
            return bunks.map(b => '<label style="font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer;padding:2px 6px;border:1px solid #e2e8f0;border-radius:4px;background:' + (selected.includes(b) ? '#dbeafe' : '#fff') + ';color:#334155;"><input type="checkbox" class="daw-bunk-cb" value="' + b + '"' + (selected.includes(b) ? ' checked' : '') + ' style="width:13px;height:13px;">' + b + '</label>').join('');
          })()}
        </div>
      </div>
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Connect To (adjacency)</div>
      <div class="ms-daw-pop-field">
        <label>Must be adjacent to</label>
        <div class="ms-daw-pop-row">
          <select id="daw-pop-custom-adjacent" style="flex:1;">
            ${(() => {
              const cur = (layer.adjacentTo || '').toString().toLowerCase();
              const opts = [
                { v: '', l: '-- None (use fixed time) --' },
                { v: 'swim', l: 'Swim' },
                { v: 'lunch', l: 'Lunch' },
                { v: 'snacks', l: 'Snacks' },
                { v: 'dismissal', l: 'Dismissal' }
              ];
              return opts.map(o => '<option value="' + o.v + '"' + (o.v === cur ? ' selected' : '') + '>' + o.l + '</option>').join('');
            })()}
          </select>
        </div>
        <div class="ms-daw-pop-hint">Pin this block next to another activity (e.g. a one-day Water Slide next to Swim) instead of a fixed time. The generator places it immediately before/after that activity.</div>
      </div>
      <div class="ms-daw-pop-field" id="daw-pop-custom-adjacent-pos-wrap" style="display:${(layer.adjacentTo || '') ? 'block' : 'none'};">
        <label>Position</label>
        <div class="ms-daw-pop-row">
          <select id="daw-pop-custom-adjacent-pos" style="flex:1;">
            <option value="either"${(layer.adjacentPosition || 'either') === 'either' ? ' selected' : ''}>Before or after (scheduler decides)</option>
            <option value="after"${(layer.adjacentPosition || '') === 'after' ? ' selected' : ''}>Immediately after</option>
            <option value="before"${(layer.adjacentPosition || '') === 'before' ? ' selected' : ''}>Immediately before</option>
          </select>
        </div>
      </div>
      <div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Sharing (how many can use it at once)</div>
      <div class="ms-daw-pop-field">
        <label>Max bunks at a time</label>
        <div class="ms-daw-pop-row">
          <input type="number" id="daw-pop-custom-share-cap" min="1" max="99" value="${(layer.customSharing && layer.customSharing.capacity) ? layer.customSharing.capacity : (_facShareDef && _facShareDef.capacity ? _facShareDef.capacity : '')}" placeholder="no limit" style="flex:1;">
        </div>
        <div class="ms-daw-pop-hint">The most bunks that can be doing this activity simultaneously (the facility's capacity). Leave blank for no limit.</div>
      </div>
      <div class="ms-daw-pop-field">
        <label>Grades allowed to share it concurrently</label>
        <div id="daw-pop-custom-share-grades" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
          ${(() => {
            const divs = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
            const allG = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(Object.keys(divs)) : Object.keys(divs);
            const sel = (layer.customSharing && Array.isArray(layer.customSharing.allowedGrades)) ? layer.customSharing.allowedGrades.map(String) : ((_facShareDef && Array.isArray(_facShareDef.allowedGrades)) ? _facShareDef.allowedGrades.map(String) : []);
            return allG.map(g => '<label style="font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer;padding:2px 6px;border:1px solid #e2e8f0;border-radius:4px;background:' + (sel.includes(String(g)) ? '#dbeafe' : '#fff') + ';color:#334155;"><input type="checkbox" class="daw-share-grade-cb" value="' + g + '"' + (sel.includes(String(g)) ? ' checked' : '') + ' style="width:13px;height:13px;">' + g + '</label>').join('');
          })()}
        </div>
        <div class="ms-daw-pop-hint">Check the grades that may use this activity at the SAME time (up to the cap above). Grades you leave unchecked still get the activity, but never at the same time as a different grade. Leave all unchecked for no grade restriction.</div>
      </div>
      ${(() => {
        // ★ Connect Across Grades — link this custom activity to the same activity
        //   in other grades so the auto builder schedules them all at the SAME
        //   start time (whatever time it picks). Connected bands glow.
        const actLow = String(layer.customActivity || '').toLowerCase().trim();
        const divsC = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
        const allGc = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(Object.keys(divsC)) : Object.keys(divsC);
        const matches = allGc.filter(g => String(g) !== String(grade) && actLow &&
          (layerSource[g] || []).some(l => l && (l.type || '').toLowerCase() === 'custom' &&
            String(l.customActivity || '').toLowerCase().trim() === actLow));
        const head = `<div class="ms-daw-pop-divider"></div>
      <div class="ms-daw-pop-section">Connect Across Grades <span style="font-weight:400;font-size:10px;letter-spacing:0;text-transform:none;color:#cbd5e1;">same time</span></div>`;
        if (!actLow) {
          return head + `<div class="ms-daw-pop-hint">Name this activity above first, then you can lock it to the same time as the same activity in other grades.</div>`;
        }
        if (matches.length === 0) {
          return head + `<div class="ms-daw-pop-hint">No other grade has a "${_mbEsc(layer.customActivity)}" activity yet. Add it to another grade to connect them.</div>`;
        }
        const curId = layer.connectionId || null;
        const cbs = matches.map(g => {
          const checked = !!(curId && (layerSource[g] || []).some(l => l && l.connectionId === curId));
          return '<label style="font-size:11px;display:flex;align-items:center;gap:3px;cursor:pointer;padding:2px 6px;border:1px solid #e2e8f0;border-radius:4px;background:' + (checked ? '#dbeafe' : '#fff') + ';color:#334155;"><input type="checkbox" class="daw-conn-grade-cb" value="' + _mbEsc(String(g)) + '"' + (checked ? ' checked' : '') + ' style="width:13px;height:13px;">' + _mbEsc(String(g)) + '</label>';
        }).join('');
        return head + `
      <div class="ms-daw-pop-field">
        <label>Lock to the same time as</label>
        <div id="daw-pop-conn-grades" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">${cbs}</div>
        <div class="ms-daw-pop-hint">Checked grades all get "${_mbEsc(layer.customActivity)}" at the SAME start time — whatever time the auto builder chooses. Their bands glow to show the link.</div>
      </div>`;
      })()}
      ` : ''}
    </div>
    <div class="ms-daw-pop-actions">
      <button class="ms-daw-pop-btn ms-daw-pop-btn-del">Delete Layer</button>
      <button class="ms-daw-pop-btn ms-daw-pop-btn-save">✓ Apply</button>
      <button class="ms-daw-pop-btn ms-daw-pop-btn-cancel">Close</button>
    </div>
  `;

  // Centered modal: append overlay + popover to body
  const overlay = document.createElement('div');
  overlay.className = 'ms-daw-popover-overlay';
  overlay.onclick = () => { overlay.remove(); popover.remove(); dawSelectedBand = null; document.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected')); };
  document.body.appendChild(overlay);
  document.body.appendChild(popover);
  requestAnimationFrame(() => popover.classList.add('ms-daw-pop-visible'));
  
  // Operator buttons — scope active-toggle to the button's OWN group (its flex
  //   wrapper), so the main qty op, the weekly op, and each per-subcategory row's
  //   op are independent (previously a single global clear made them clobber each
  //   other / made all subcategory rows share one operator).
  popover.querySelectorAll('.ms-daw-pop-op').forEach(btn => {
    btn.onclick = () => {
      const grp = btn.parentElement || popover;
      grp.querySelectorAll('.ms-daw-pop-op').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Live total for special-layer per-subcategory grid.
  const subqInputs = popover.querySelectorAll('.ms-daw-subq-input');
  const subqTotalEl = popover.querySelector('#daw-pop-subq-total');
  if (subqInputs.length && subqTotalEl) {
    const recalcTotal = () => {
      let t = 0;
      subqInputs.forEach(i => { t += Math.max(0, parseInt(i.value, 10) || 0); });
      subqTotalEl.textContent = String(t);
    };
    subqInputs.forEach(i => i.addEventListener('input', recalcTotal));
  }
  
  // Grade Mode toggle (swim / lunch / snacks)
  popover.querySelectorAll('.ms-daw-grademode[data-gmode]').forEach(btn => {
    btn.onclick = () => {
      popover.querySelectorAll('.ms-daw-grademode[data-gmode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Close X button
  const closeXBtn = popover.querySelector('#daw-pop-close-x');
  if (closeXBtn) closeXBtn.onclick = () => {
    popover.remove();
    document.querySelectorAll('.ms-daw-popover-overlay').forEach(o => o.remove());
    dawSelectedBand = null;
    document.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
  };

  // Custom layer: field dropdown toggle + bunk select/deselect
  const customFieldSelect = popover.querySelector('#daw-pop-custom-field');
  if (customFieldSelect) {
    customFieldSelect.onchange = function() {
      const wrap = popover.querySelector('#daw-pop-custom-field-text-wrap');
      if (wrap) wrap.style.display = this.value === '_custom' ? 'block' : 'none';
    };
  }
  // Connect-to (adjacency): show the Position picker only when a target is chosen.
  const customAdjSelect = popover.querySelector('#daw-pop-custom-adjacent');
  if (customAdjSelect) {
    customAdjSelect.onchange = function() {
      const wrap = popover.querySelector('#daw-pop-custom-adjacent-pos-wrap');
      if (wrap) wrap.style.display = this.value ? 'block' : 'none';
    };
  }
  const bunkAllBtn = popover.querySelector('#daw-pop-bunk-all');
  const bunkNoneBtn = popover.querySelector('#daw-pop-bunk-none');
  if (bunkAllBtn) {
    bunkAllBtn.onclick = () => {
      popover.querySelectorAll('.daw-bunk-cb').forEach(cb => { cb.checked = true; cb.closest('label').style.background = '#dbeafe'; });
    };
  }
  if (bunkNoneBtn) {
    bunkNoneBtn.onclick = () => {
      popover.querySelectorAll('.daw-bunk-cb').forEach(cb => { cb.checked = false; cb.closest('label').style.background = '#fff'; });
    };
  }
  popover.querySelectorAll('.daw-bunk-cb').forEach(cb => {
    cb.onchange = function() { this.closest('label').style.background = this.checked ? '#dbeafe' : '#fff'; };
  });
  popover.querySelectorAll('.daw-conn-grade-cb').forEach(cb => {
    cb.onchange = function() { this.closest('label').style.background = this.checked ? '#dbeafe' : '#fff'; };
  });

  // Save
  popover.querySelector('.ms-daw-pop-btn-save').onclick = () => {
    const startStr = popover.querySelector('#daw-pop-start').value;
    const endStr = popover.querySelector('#daw-pop-end').value;
    const s = parseTimeToMinutes(startStr);
    const e2 = parseTimeToMinutes(endStr);
    if (s != null) layer.startMin = s;
    if (e2 != null) layer.endMin = e2;
    layer.durationMin = parseInt(popover.querySelector('#daw-pop-dur-min').value) || 30;
    layer.durationMax = parseInt(popover.querySelector('#daw-pop-dur-max').value) || 50;
    layer.periodMin = layer.durationMin; // backward compat

    // ★ Special-layer per-subcategory grid: collect values, drop the legacy
    //   single-tag `subcategory` field, and set qty=sum so downstream code
    //   that hasn't been migrated still sees the right total.
    const _subqInputs = popover.querySelectorAll('.ms-daw-subq-input');
    if (layer.type === 'special' && _subqInputs.length > 0) {
      // Map each subcategory → its active operator (≥/=/≤) from its row's buttons.
      const _activeOpBySub = {};
      popover.querySelectorAll('.ms-daw-subq-op.active').forEach(b => {
        if (b.dataset && b.dataset.subname) _activeOpBySub[b.dataset.subname] = b.dataset.op || '=';
      });
      const subQ = {};
      const subOps = {};
      let total = 0;
      _subqInputs.forEach(inp => {
        const name = inp.dataset.subname || '';
        const v = Math.max(0, parseInt(inp.value, 10) || 0);
        if (!name) return;
        if (v > 0) {
          subQ[name] = v; total += v;
          const op = _activeOpBySub[name];
          subOps[name] = (op === '>=' || op === '<=' || op === '=') ? op : '=';
        }
      });
      layer.subQuantities = subQ;
      layer.subOps = subOps;           // per-subcategory operator (≥/=/≤)
      layer.qty = Math.max(1, total); // keep ≥1 so legacy paths don't no-op
      layer.op = '=';                  // layer-level op unused when subQuantities present
      delete layer.subcategory;        // superseded by subQuantities
    } else {
      const qtyEl = popover.querySelector('#daw-pop-qty');
      if (qtyEl) layer.qty = parseInt(qtyEl.value) || 1;
      const activeOp = popover.querySelector('.ms-daw-pop-op[data-op].active');
      if (activeOp) layer.op = activeOp.dataset.op;
    }

   // Rotation: Bunks Per Day + Times Per Week (all layer types)
    const bpdRaw = (popover.querySelector('#daw-pop-bpd')?.value || '').trim();
    layer.bunksPerDay = bpdRaw !== '' ? Math.max(1, parseInt(bpdRaw) || 1) : null;

    const activeWop = popover.querySelector('.ms-daw-wop[data-wop].active');
    const weekQtyRaw = (popover.querySelector('#daw-pop-week-qty')?.value || '').trim();
    const weekQtyVal = weekQtyRaw !== '' ? Math.max(1, Math.min(7, parseInt(weekQtyRaw) || 1)) : null;
    layer.timesPerWeek = weekQtyVal;
    layer.weeklyOp = weekQtyVal != null && activeWop ? activeWop.dataset.wop : '>=';

    // Grade Mode: save fullGrade for swim / lunch / snacks
    const activeGmode = popover.querySelector('.ms-daw-grademode[data-gmode].active');
    if (activeGmode) {
      layer.fullGrade = activeGmode.dataset.gmode === 'fullgrade';
    }

    // League: save selected league name
    if (layer.type === 'league' || layer.type === 'specialty_league') {
      const leagueSelect = popover.querySelector('#daw-pop-league-name');
      if (leagueSelect) layer.leagueName = leagueSelect.value;
    }

    // Change Time: save preChangeMin / postChangeMin for swim
    if (layer.type === 'swim') {
      const preEl  = popover.querySelector('#daw-pop-pre-change');
      const postEl = popover.querySelector('#daw-pop-post-change');
      layer.preChangeMin  = preEl  && preEl.value.trim()  !== '' ? Math.max(0, parseInt(preEl.value)  || 0) : null;
      layer.postChangeMin = postEl && postEl.value.trim() !== '' ? Math.max(0, parseInt(postEl.value) || 0) : null;
    }

    // Custom layer: save activity name, field, and bunks
    if (layer.type === 'custom') {
      layer.customActivity = (popover.querySelector('#daw-pop-custom-name')?.value || '').trim() || null;
      const fieldSelect = popover.querySelector('#daw-pop-custom-field');
      const fieldText = popover.querySelector('#daw-pop-custom-field-text');
      if (fieldSelect) {
        if (fieldSelect.value === '_custom') {
          layer.customField = (fieldText?.value || '').trim() || null;
        } else {
          layer.customField = fieldSelect.value || null;
        }
      }
      const checkedBunks = Array.from(popover.querySelectorAll('.daw-bunk-cb:checked')).map(cb => cb.value);
      const divs = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
      const allBunks = (divs[grade]?.bunks || []).map(String);
      layer.customBunks = checkedBunks.length === allBunks.length ? null : checkedBunks; // null = all
      // ★ Connect-to (adjacency): pin this custom block next to another activity
      //   (e.g. a one-day Water Slide next to Swim) instead of a fixed time.
      const adjSel = popover.querySelector('#daw-pop-custom-adjacent');
      const adjPosSel = popover.querySelector('#daw-pop-custom-adjacent-pos');
      layer.adjacentTo = (adjSel && adjSel.value) ? adjSel.value : null;
      layer.adjacentPosition = (adjPosSel && adjPosSel.value) ? adjPosSel.value : 'either';
      // ★ Sharing: how many bunks can do this activity at once + which grades may
      //   share it concurrently. The generator caps concurrent use accordingly
      //   (mirrors the Field/Pool sharing model).
      const shareCapEl = popover.querySelector('#daw-pop-custom-share-cap');
      const shareGrades = Array.from(popover.querySelectorAll('.daw-share-grade-cb:checked')).map(cb => cb.value);
      const shareCap = shareCapEl ? parseInt(shareCapEl.value, 10) : NaN;
      if ((!isNaN(shareCap) && shareCap > 0) || shareGrades.length > 0) {
        layer.customSharing = {
          capacity: (!isNaN(shareCap) && shareCap > 0) ? shareCap : null,
          allowedGrades: shareGrades
        };
      } else {
        layer.customSharing = null;
      }
      // ★ Connect Across Grades: rebuild this activity's connection group from
      //   the checked grades so they all schedule at the SAME start time.
      const connGrades = Array.from(popover.querySelectorAll('.daw-conn-grade-cb:checked')).map(cb => cb.value);
      _dawApplyGradeConnection(layer, grade, connGrades, layerSource);
    }
    document.querySelectorAll('.ms-daw-popover-overlay').forEach(o => o.remove());
    popover.remove();
    onSave();
    onRender();
  };

  // Delete
  popover.querySelector('.ms-daw-pop-btn-del').onclick = () => {
    const src = opts?.layerSource || dawLayers;
    src[grade] = (src[grade] || []).filter(l => l.id !== layer.id);
    dawSelectedBand = null;
    document.querySelectorAll('.ms-daw-popover-overlay').forEach(o => o.remove());
    popover.remove();
    onSave();
    onRender();
  };
  
  // Close
  popover.querySelector('.ms-daw-pop-btn-cancel').onclick = () => {
    popover.remove();
    document.querySelectorAll('.ms-daw-popover-overlay').forEach(o => o.remove());
    dawSelectedBand = null;
    document.querySelectorAll('.ms-daw-band').forEach(b => b.classList.remove('selected'));
  };
}

// ★ Day 24: Auto-builder bunk overrides.
//   Concept mirrors the Manual Builder bunk override flow (pick a grade,
//   then see the same grade view but expanded to one column per BUNK
//   instead of one column per grade), but the visual is the auto-builder
//   timeline style: vertical time-rail on the left, each bunk gets its own
//   column with the SAME layer bands the grade has. Click any band to
//   override that bunk's activity for that time slot.
//   Storage = same `bunkActivityOverrides` array Daily Adjustments uses,
//   so the auto-gen pipeline already honours it (Phase 0 override
//   injection in scheduler_core_auto.js).
function openAutoBunkOverridesPanel(grade) {
    const divisions = window.divisions || {};
    const div = divisions[grade];
    if (!div) { window.showAlert?.('Division not found.'); return; }
    // ★ FN-49: keep the user's Camp Structure order (no alphanumeric re-sort)
    const bunks = (div.bunks || []).slice();
    if (bunks.length === 0) { window.showAlert?.('No bunks in this division.'); return; }
    // ★ Day 24: read the layers the grid ACTUALLY rendered — in the DA auto
    //   view that's the externalLayers arg (daAutoLayers), not the module
    //   dawLayers (which only holds the master-view template). Without this the
    //   panel found no layers in the DA context and silently returned.
    const _laySrc = _lastDAWLayerSource || dawLayers;
    const layers = ((_laySrc && _laySrc[grade]) || []).slice().sort((a, b) => a.startMin - b.startMin);
    if (layers.length === 0) {
        window.showAlert?.('No layers in this grade yet. Add a layer first.');
        return;
    }

    // Grade time bounds for the time-rail
    const gradeStart = parseTimeToMinutes(div.startTime) || Math.min(...layers.map(l => l.startMin));
    const gradeEnd   = parseTimeToMinutes(div.endTime)   || Math.max(...layers.map(l => l.endMin));
    // Expand to layer bounds if layers stretch beyond grade times
    const railStart = Math.min(gradeStart, ...layers.map(l => l.startMin));
    const railEnd   = Math.max(gradeEnd,   ...layers.map(l => l.endMin));
    const PX = DAW_PIXELS_PER_MINUTE;
    const totalHeight = (railEnd - railStart) * PX;
    const BAND_W = DAW_BAND_WIDTH;
    const BAND_G = DAW_BAND_GAP;
    const BAND_P = 6;
    const colWidth = Math.max(140, layers.length * (BAND_W + BAND_G) + BAND_P * 2);

    // Read / save overrides
    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    const getOverrides = () => {
        if (typeof window._boGetCurrentOverrides === 'function') return window._boGetCurrentOverrides();
        const dd = window.loadCurrentDailyData ? window.loadCurrentDailyData() : {};
        return dd.bunkActivityOverrides || [];
    };
    const saveOverrides = (list) => {
        if (typeof window._boSaveOverrides === 'function') return window._boSaveOverrides(list);
        if (window.saveCurrentDailyData) window.saveCurrentDailyData('bunkActivityOverrides', list);
        try { localStorage.setItem('campBunkOverrides_' + dateKey, JSON.stringify(list)); } catch(_) {}
    };

    // Build overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:14px;width:100%;max-width:1500px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 16px 40px rgba(0,0,0,0.3);overflow:hidden;';
    overlay.appendChild(panel);

    const renderInner = () => {
        const overrides = getOverrides();
        const gradeOverrides = overrides.filter(o => bunks.map(String).includes(String(o.bunk)));

        // Header
        let header = '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #e5e7eb;background:#f9fafb;flex-shrink:0;">';
        header += '<div><h2 style="margin:0;font-size:17px;color:#1e293b;font-weight:700;">🎯 Bunk Overrides — ' + grade + '</h2>';
        header += '<p style="margin:3px 0 0;font-size:11px;color:#64748b;">Click any layer band to override that bunk\'s activity for that slot. Saved automatically.</p></div>';
        header += '<div style="display:flex;gap:8px;align-items:center;">';
        if (gradeOverrides.length > 0) {
            header += '<span style="font-size:12px;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:99px;padding:3px 10px;font-weight:600;">' + gradeOverrides.length + ' override' + (gradeOverrides.length === 1 ? '' : 's') + '</span>';
            header += '<button id="abo-clear-grade" style="background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;font-weight:600;">Clear All</button>';
        }
        header += '<button id="abo-close" style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;padding:5px 14px;font-size:13px;cursor:pointer;font-weight:600;">Close</button>';
        header += '</div></div>';

        // Build per-bunk DAW-style grid (matches the auto builder visual)
        let grid = '<div style="display:flex;overflow:auto;flex:1;padding:14px;background:#fafafa;">';

        // Time ruler (left)
        const RAIL_W = 60;
        grid += '<div style="width:' + RAIL_W + 'px;flex-shrink:0;position:sticky;left:0;background:#fafafa;z-index:2;">';
        grid += '<div style="height:36px;border-bottom:1px solid #e5e7eb;"></div>'; // header spacer
        grid += '<div style="position:relative;height:' + totalHeight + 'px;">';
        // 30-min tick marks
        for (let m = railStart; m <= railEnd; m += 30) {
            const top = (m - railStart) * PX;
            const major = m % 60 === 0;
            grid += '<div style="position:absolute;top:' + top + 'px;left:0;right:0;font-size:10px;color:#94a3b8;padding-left:4px;border-top:1px ' + (major ? 'solid #cbd5e1' : 'dashed #e5e7eb') + ';">' + minutesToTime(m) + '</div>';
        }
        grid += '</div></div>';

        // Per-bunk columns
        bunks.forEach(bunk => {
            const bOvs = overrides.filter(o => String(o.bunk) === String(bunk));
            grid += '<div style="width:' + colWidth + 'px;flex-shrink:0;margin-left:6px;">';
            // Bunk header
            const badge = bOvs.length > 0 ? '<span style="background:#ef4444;color:#fff;border-radius:99px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px;">' + bOvs.length + '</span>' : '';
            grid += '<div style="height:36px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f766e 0%,#0d9488 100%);color:#fff;border-radius:8px 8px 0 0;font-weight:700;font-size:13px;border-bottom:2px solid #0d9488;">' + bunk + badge + '</div>';
            // Track
            grid += '<div style="position:relative;height:' + totalHeight + 'px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">';
            // Horizontal gridlines
            for (let m = railStart + 30; m < railEnd; m += 30) {
                const top = (m - railStart) * PX;
                const major = m % 60 === 0;
                grid += '<div style="position:absolute;top:' + top + 'px;left:0;right:0;border-top:1px ' + (major ? 'solid #f1f5f9' : 'dashed #f8fafc') + ';"></div>';
            }
            // Layer bands (one per layer)
            layers.forEach((layer, idx) => {
                const top = (layer.startMin - railStart) * PX;
                const height = Math.max(24, (layer.endMin - layer.startMin) * PX);
                const left = BAND_P + idx * (BAND_W + BAND_G);
                const ov = bOvs.find(o => o.startMin === layer.startMin && o.endMin === layer.endMin);
                const typeDef = DAW_LAYER_TYPES.find(t => t.type === layer.type);
                const defaultLabel = layer.leagueName || typeDef?.name || layer.type;

                if (ov) {
                    // Override band — yellow highlight
                    grid += '<div class="abo-band abo-ov" data-bunk="' + bunk + '" data-sm="' + layer.startMin + '" data-em="' + layer.endMin + '" data-ov-id="' + (ov.id || '') + '" '
                        + 'style="position:absolute;top:' + top + 'px;height:' + height + 'px;left:' + left + 'px;width:' + BAND_W + 'px;'
                        + 'background:linear-gradient(180deg,#fef3c7 0%,#fde68a 100%);border:2px solid #f59e0b;border-radius:6px;cursor:pointer;'
                        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 2px;overflow:hidden;font-size:10px;color:#78350f;font-weight:700;text-align:center;line-height:1.1;" '
                        + 'title="Override: ' + ov.activity + ' (' + minutesToTime(layer.startMin) + '–' + minutesToTime(layer.endMin) + ')">'
                        + '<span style="word-break:break-word;">' + ov.activity + '</span>'
                        + '<span class="abo-revert" data-ov-id="' + (ov.id || '') + '" style="position:absolute;top:1px;right:3px;font-size:11px;color:#dc2626;font-weight:bold;cursor:pointer;" title="Revert">×</span>'
                        + '</div>';
                } else {
                    // Default band — pale, hint to override
                    const bgColor = typeDef?.style ? typeDef.style.split('background:')[1]?.split(';')[0] || '#e2e8f0' : '#e2e8f0';
                    grid += '<div class="abo-band abo-default" data-bunk="' + bunk + '" data-sm="' + layer.startMin + '" data-em="' + layer.endMin + '" '
                        + 'style="position:absolute;top:' + top + 'px;height:' + height + 'px;left:' + left + 'px;width:' + BAND_W + 'px;'
                        + 'background:' + bgColor + ';opacity:0.55;border:1px dashed #94a3b8;border-radius:6px;cursor:pointer;'
                        + 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4px 2px;overflow:hidden;font-size:10px;color:#334155;font-weight:600;text-align:center;line-height:1.1;" '
                        + 'title="' + defaultLabel + ' (default for ' + grade + ') — click to override for ' + bunk + '">'
                        + '<span style="word-break:break-word;">' + defaultLabel + '</span>'
                        + '</div>';
                }
            });
            grid += '</div></div>';
        });

        grid += '</div>';
        panel.innerHTML = header + grid;

        // Wire up clicks
        panel.querySelector('#abo-close').onclick = () => overlay.remove();
        const clearBtn = panel.querySelector('#abo-clear-grade');
        if (clearBtn) {
            clearBtn.onclick = async () => {
                const ok = window.showConfirm ? await window.showConfirm('Remove all bunk overrides for ' + grade + '?') : window.confirm('Remove all bunk overrides for ' + grade + '?');
                if (!ok) return;
                const remaining = getOverrides().filter(o => !bunks.map(String).includes(String(o.bunk)));
                saveOverrides(remaining);
                renderInner();
            };
        }
        // Revert buttons
        panel.querySelectorAll('.abo-revert').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const ovId = btn.dataset.ovId;
                const remaining = getOverrides().filter(o => String(o.id) !== String(ovId));
                saveOverrides(remaining);
                renderInner();
            };
        });
        // Band click → activity picker
        panel.querySelectorAll('.abo-band').forEach(band => {
            band.onclick = (e) => {
                if (e.target.classList.contains('abo-revert')) return;
                const bunk = band.dataset.bunk;
                const sm = parseInt(band.dataset.sm);
                const em = parseInt(band.dataset.em);
                if (typeof window._boShowPicker === 'function') {
                    window._boShowPicker(band, bunk, sm, em);
                    setTimeout(renderInner, 350);
                } else {
                    const act = prompt('Activity name for ' + bunk + ' at ' + minutesToTime(sm) + '-' + minutesToTime(em) + ':');
                    if (!act) return;
                    const list = getOverrides();
                    const filtered = list.filter(o => !(String(o.bunk) === String(bunk) && o.startMin === sm && o.endMin === em));
                    filtered.push({
                        id: 'abo_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
                        bunk, activity: act, location: null,
                        startTime: minutesToTime(sm), endTime: minutesToTime(em),
                        startMin: sm, endMin: em, type: 'sport'
                    });
                    saveOverrides(filtered);
                    renderInner();
                }
            };
        });
    };

    renderInner();
    document.body.appendChild(overlay);
}

async function dawAddLayerDialog(grade) {
  const div = (window.divisions || {})[grade] || {};
  const divStart = parseTimeToMinutes(div.startTime) || 540;
  const divEnd = parseTimeToMinutes(div.endTime) || 960;
  
  const typeOptions = DAW_LAYER_TYPES.filter(t => !t.hidden).map(t => ({ value: t.type, label: t.name }));
  
  const result = await showModal({
    title: `Add Layer to ${grade}`,
    fields: [
      { name: 'type', label: 'Layer Type', type: 'select', options: typeOptions, default: 'activity' },
      { name: 'startTime', label: 'Start Time', type: 'time', default: minutesToTime(divStart), placeholder: '9:00am' },
      { name: 'endTime', label: 'End Time', type: 'time', default: minutesToTime(divEnd), placeholder: '4:00pm' },
    ],
    confirmText: 'Add Layer'
  });
  
  if (!result) return;
  
  const startMin = parseTimeToMinutes(result.startTime) || divStart;
  const endMin = parseTimeToMinutes(result.endTime) || divEnd;
  
  if (!dawLayers[grade]) dawLayers[grade] = [];
  const layerDef = DAW_LAYER_TYPES.find(t => t.type === result.type);
  
 const _addedLayer = {
    id: 'daw_' + Math.random().toString(36).slice(2, 9),
    type: result.type,
    startMin: Math.max(divStart, startMin),
    endMin: Math.min(divEnd, endMin),
    qty: 1,
    op: layerDef?.anchor ? '=' : '>=',
    durationMin: layerDef?.anchor ? (endMin - startMin) : 30,
    durationMax: layerDef?.anchor ? (endMin - startMin) : 50,
    periodMin: layerDef?.anchor ? (endMin - startMin) : 30,
  };

  // ★ Multi-league picker for auto builder Add Layer dialog
  if (result.type === 'league' || result.type === 'specialty_league') {
    const _gradeLeagues = _mbLeaguesForGradeByType(grade, result.type);
    if (_gradeLeagues.length === 0) {
      await showAlert('No leagues are assigned to ' + grade +
        '. Add this grade to a league in League Setup before adding a league layer here.');
      return;
    } else if (_gradeLeagues.length === 1) {
      _addedLayer.leagueName = _gradeLeagues[0];
    } else {
      const _pickResult = await showModal({
        title: 'Which League?',
        fields: [{
          name: 'leagueName',
          label: 'Which League? (required)',
          type: 'select',
          options: [{ value: '', label: '— Choose a league —' }]
            .concat(_gradeLeagues.map(ln => ({ value: ln, label: ln }))),
          default: ''
        }]
      });
      if (!_pickResult || !_pickResult.leagueName) return;
      _addedLayer.leagueName = _pickResult.leagueName;
    }
  }

  dawLayers[grade].push(_addedLayer);

  saveDAWLayers();
  renderDAWGrid();
}

async function dawCopyLayersDialog() {
  const divisions = window.divisions || {};
  const _gradesRaw = Object.keys(divisions).filter(d => !divisions[d].isParent);
  const grades = (typeof window.getUserDivisionOrder === 'function') ? window.getUserDivisionOrder(_gradesRaw) : _gradesRaw.sort();
  
  if (grades.length < 2) {
    await showAlert('Need at least 2 grades to copy between.');
    return;
  }
  
  const result = await showModal({
    title: 'Copy Layers',
    description: 'Copy all layers from one grade to others.',
    fields: [
      { name: 'from', label: 'Copy From', type: 'select', options: grades.map(g => ({ value: g, label: g })) },
      { name: 'to', label: 'Copy To', type: 'checkbox-group', options: grades },
    ],
    confirmText: 'Copy'
  });
  
  if (!result || !result.from || !result.to || result.to.length === 0) return;

  const source = dawLayers[result.from] || [];
  let copied = 0;
  let replaced = 0;  // ★ count of target grades whose pre-existing layers were replaced

  // ★ ALSO propagate / clear Bell Schedule periods. Two storage locations
  //   must be synced: window.campPeriods (runtime, read by gen) AND
  //   app1.autoLayerTemplatePeriods (template snapshots). A stray Period 1
  //   on the target (e.g. from earlier UI exploration) was constraining
  //   the slot grid forever after Copy because the runtime store survived.
  try {
    const gs = window.loadGlobalSettings ? window.loadGlobalSettings() : {};
    const app1 = gs.app1 || {};
    const _clonePeriods = (arr) => (arr || []).map(p => Object.assign(
      {}, JSON.parse(JSON.stringify(p)),
      { id: 'bp_' + Math.random().toString(36).slice(2, 10) }
    ));
    let pChanged = false;

    // 1. Runtime store
    if (!window.campPeriods) window.campPeriods = {};
    const liveSrc = window.campPeriods[result.from] || [];
    result.to.forEach(targetGrade => {
      if (targetGrade === result.from) return;
      if (liveSrc.length === 0) {
        if (window.campPeriods[targetGrade]) {
          delete window.campPeriods[targetGrade];
          pChanged = true;
        }
      } else {
        window.campPeriods[targetGrade] = _clonePeriods(liveSrc);
        pChanged = true;
      }
    });
    if (pChanged) {
      window.saveGlobalSettings && window.saveGlobalSettings('campPeriods', window.campPeriods);
      window.dispatchEvent(new CustomEvent('campistry-periods-changed'));
    }

    // 2. Template snapshots
    const periodStore = app1.autoLayerTemplatePeriods || {};
    Object.keys(periodStore).forEach(templateKey => {
      const perGrade = periodStore[templateKey] || {};
      const srcPeriods = perGrade[result.from] || [];
      result.to.forEach(targetGrade => {
        if (targetGrade === result.from) return;
        if (srcPeriods.length === 0) {
          if (perGrade[targetGrade]) {
            delete perGrade[targetGrade];
            pChanged = true;
          }
        } else {
          perGrade[targetGrade] = _clonePeriods(srcPeriods);
          pChanged = true;
        }
      });
    });
    if (pChanged) {
      app1.autoLayerTemplatePeriods = periodStore;
      window.saveGlobalSettings && window.saveGlobalSettings('app1', app1);
      window.forceSyncToCloud && window.forceSyncToCloud();
    }
  } catch (_ePeriods) { /* non-fatal */ }

  result.to.forEach(targetGrade => {
    if (targetGrade === result.from) return;
    // Clone layers with new IDs, adjusting to target division times
    const targetDiv = divisions[targetGrade] || {};
    const tStart = parseTimeToMinutes(targetDiv.startTime) || 540;
    const tEnd = parseTimeToMinutes(targetDiv.endTime) || 960;

    // ★ FIX: Always replace target — no silent skip when grade already has layers.
    //   Previously a pre-existing layer (e.g. one accidentally dragged via drift)
    //   could leave a grade looking copied-to in the UI checkbox but actually
    //   starving the downstream slot grid because Copy never overwrote it.
    //   Track replacements explicitly so the success message tells the user
    //   what just happened.
    const hadExisting = Array.isArray(dawLayers[targetGrade]) && dawLayers[targetGrade].length > 0;
    if (hadExisting) replaced++;

    dawLayers[targetGrade] = source.map(l => {
      const copy = {
        ...JSON.parse(JSON.stringify(l)),
        id: 'daw_' + Math.random().toString(36).slice(2, 9),
        startMin: Math.max(tStart, l.startMin),
        endMin: Math.min(tEnd, l.endMin),
      };
      _mbRemapLeagueForGrade(copy, targetGrade);
      return copy;
    });

    // ★ Invalidate cached per-bunk slot grid for the target grade. Without
    //   this the next generation can read stale _perBunkSlots derived from
    //   the OLD layer set, producing the "3-slot Intermediates" symptom even
    //   though dawLayers itself was correctly overwritten.
    try {
      if (window.divisionTimes && window.divisionTimes[targetGrade]) {
        delete window.divisionTimes[targetGrade]._perBunkSlots;
        delete window.divisionTimes[targetGrade]._slots;
        delete window.divisionTimes[targetGrade]._builtAt;
      }
    } catch (_e) { /* non-fatal */ }

    copied++;
  });

  saveDAWLayers();
  renderDAWGrid();
  const _msg = replaced > 0
    ? `Copied layers to ${copied} grade(s) — replaced existing layers in ${replaced}.`
    : `Copied layers to ${copied} grade(s).`;
  await showAlert(_msg);
}

function renderDAW() {
  loadDAWLayers();
  renderDAWPalette();
  renderDAWToolbar();
  renderDAWExpandSection();
  renderDAWGrid();
}

// ★ FN-45: remote layer-template changes (another device or tab) re-hydrate
//   storage — reload + re-render the DAW so this editor doesn't save a stale
//   template wholesale over the other writer's layers. Skipped mid-drag and
//   while the local editor holds unsaved changes (last-writer-wins on save).
(function () {
  let _dawRefreshTimer = null;
  function _refreshDAWFromStorage() {
    if (_dawRefreshTimer) clearTimeout(_dawRefreshTimer);
    _dawRefreshTimer = setTimeout(() => {
      _dawRefreshTimer = null;
      try {
        if (dawDragData) return;
        if (typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges) return;
        const pal = document.getElementById('daw-palette');
        if (pal && pal.offsetParent !== null) renderDAW();
        // Not visible: nothing cached to refresh — renderDAW() re-runs
        // loadDAWLayers() the next time the auto view opens.
      } catch (e) { console.warn('[MS] hydrate refresh failed:', e); }
    }, 250);
  }
  window.addEventListener('campistry-cloud-hydrated', _refreshDAWFromStorage);
  window.addEventListener('storage', (e) => {
    if (e && e.key === 'CAMPISTRY_LOCAL_CACHE') _refreshDAWFromStorage();
  });
})();
function updateToolbarStatus() {
  const statusGroup = document.querySelector('.ms-toolbar-group.status');
  if (statusGroup) {
    statusGroup.classList.toggle('has-changes', hasUnsavedChanges);
    const badge = statusGroup.querySelector('.ms-status-badge');
    if (hasUnsavedChanges && !badge) {
      const nameEl = statusGroup.querySelector('.ms-status-name');
      nameEl.insertAdjacentHTML('afterend', '<span class="ms-status-badge">Unsaved</span>');
    } else if (!hasUnsavedChanges && badge) {
      badge.remove();
    }
  }
}

// --- Render Expand Section (Assignments) ---
function renderExpandSection() {
  const expandEl = document.getElementById('scheduler-expand');
  if (!expandEl) return;
  
  const saved = window.getSavedSkeletons?.() || {};
  const names = Object.keys(saved).sort();
  const assignments = window.getSkeletonAssignments?.() || {};
  const loadOptions = names.map(n => `<option value="${n}">${n}</option>`).join('');
  
  expandEl.innerHTML = `
    <span class="ms-expand-trigger" onclick="this.nextElementSibling.classList.toggle('open')">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
      Day Assignments
    </span>
    <div class="ms-expand-content">
      <div class="ms-assign-grid">
        ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Default"].map(day => `
          <div class="ms-assign-item">
            <label>${day}</label>
            <select data-day="${day}">
              <option value="">None</option>
              ${loadOptions}
            </select>
          </div>
        `).join('')}
      </div>
      <button id="assign-save-btn" class="ms-btn ms-btn-success" style="margin-top:12px;">Save Assignments</button>
    </div>
  `;
  
  expandEl.querySelectorAll('select[data-day]').forEach(sel => {
    sel.value = assignments[sel.dataset.day] || '';
  });
  
  document.getElementById('assign-save-btn').onclick = async () => {
    const map = {};
    expandEl.querySelectorAll('select[data-day]').forEach(s => { 
      if (s.value) map[s.dataset.day] = s.value; 
    });
    window.saveSkeletonAssignments?.(map);
    window.forceSyncToCloud?.();
    await showAlert('Assignments saved.');
  };
}

// --- Render Palette ---
function renderPalette() {
  palette.innerHTML = '';
  
  const categories = [
    { label: 'Slots', types: ['activity', 'sports', 'special'] },
    { label: 'Advanced', types: ['smart', 'split', 'elective', 'swim_elective'] },
    { label: 'Leagues', types: ['league', 'specialty_league'] },
    { label: 'Fixed', types: ['swim', 'lunch', 'snacks', 'dismissal', 'custom'] }
  ];

  // ★ FN-48: every custom general activity (facilities registry) gets its own
  //   pinned tile — same lane as the auto-mode palette. The tile carries
  //   gaName/gaFacility so the drop pre-binds the event + facility and only
  //   asks for the times.
  const _gaItems = (window.getGeneralActivityPaletteItems?.() || []);
  if (_gaItems.length) {
    categories.push({
      label: 'General Activities',
      tiles: _gaItems.map(ga => ({
        type: 'custom',
        name: ga.name,
        style: 'background:#fef3c7;color:#92400e;',
        description: 'Pinned general activity at ' + ga.facility + '. Drop on a division and set the times.',
        gaName: ga.name,
        gaFacility: ga.facility
      }))
    });
  }

  categories.forEach((cat, catIndex) => {
    const label = document.createElement('div');
    label.className = 'ms-tile-label';
    label.textContent = cat.label;
    palette.appendChild(label);

    const catTiles = cat.tiles || cat.types.map(type => TILES.find(t => t.type === type));
    catTiles.forEach(tile => {
      if (!tile) return;
      
      const el = document.createElement('div');
      el.className = 'ms-tile';
      el.draggable = true;
      el.title = tile.description || '';

      const dot = document.createElement('span');
      dot.className = 'ms-tile-dot';
      const bgMatch = (tile.style || '').match(/background:([^;]+)/);
      dot.style.background = bgMatch ? bgMatch[1].trim() : '#64748b';
      el.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'ms-tile-name';
      name.textContent = tile.name;
      el.appendChild(name);
      
      el.onclick = (e) => {
        if (e.detail === 1) {
          setTimeout(() => {
            if (!el.dragging) showTileInfo(tile);
          }, 200);
        }
      };
      
      el.ondragstart = (e) => { 
        el.dragging = true;
        e.dataTransfer.setData('application/json', JSON.stringify(tile)); 
      };
      el.ondragend = () => { el.dragging = false; };
      
      // Mobile touch — primary handling by mobile_touch_drag.js
      let touchStartY = 0;
      el.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        el.dataset.tileData = JSON.stringify(tile);
        if (!window.MobileTouchDrag) el.style.opacity = '0.6';
      });
      
      el.addEventListener('touchend', (e) => {
        el.style.opacity = '1';
        if (window.MobileTouchDrag) return;
        const touch = e.changedTouches[0];
        if (Math.abs(touch.clientY - touchStartY) < 10) {
          showTileInfo(tile);
          return;
        }
        const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
        const cell = elementAtPoint?.closest('.grid-cell');
        if (cell?.ondrop) {
          cell.ondrop({
            preventDefault: () => {},
            clientX: touch.clientX,
            clientY: touch.clientY,
            dataTransfer: {
              getData: (t) => t === 'application/json' ? JSON.stringify(tile) : '',
              types: ['application/json']
            }
          });
        }
      });
      
      palette.appendChild(el);
    });
    
    if (catIndex < categories.length - 1) {
      const divider = document.createElement('div');
      divider.className = 'ms-tile-divider';
      palette.appendChild(divider);
    }
  });
}

function showTileInfo(tile) {
  const descriptions = {
    'activity': 'ACTIVITY SLOT\n\nA flexible time block where the scheduler assigns either a sport or special activity based on availability and fairness rules.',
    'sports': 'SPORTS SLOT\n\nDedicated time for sports activities only. The scheduler will assign an available field and sport.',
    'special': 'SPECIAL ACTIVITY\n\nTime reserved for special activities like Art, Music, Drama, etc.',
    'smart': 'SMART TILE\n\nCalculates how many bunks can do Main 1 based on capacity:\n\n• Bunks that fit → Main 1\n• Everyone else → Main 2\n• If Main 1 is full → Fallback is used\n\nNext period, groups SWAP:\n• Main 1 bunks → get Main 2\n• Main 2 bunks → get Main 1\n\nExample: Main 1 = Swim (capacity 4), Main 2 = Sports\nPeriod 1: Bunks 1-4 swim, Bunks 5-8 sports\nPeriod 2: Bunks 5-8 swim, Bunks 1-4 sports\n\nNote: Enter tile types (Sports, Special) not specific activities.',
    'split': 'SPLIT ACTIVITY\n\nSplits the division into two groups for the time block:\n\n• First half of time:\n   - Group 1 does Main 1\n   - Group 2 does Main 2\n• Midway through: Groups SWAP\n• Second half of time:\n   - Group 1 does Main 2\n   - Group 2 does Main 1\n\nExamples: Swim, Sports, Art, Special, Activity',
    'elective': 'ELECTIVE\n\nReserves specific fields/activities for THIS division only. Other divisions cannot use them during this time.',
    'league': 'LEAGUE GAME\n\nFull buyout for a regular league matchup. All bunks in the division play head-to-head games.',
    'specialty_league': 'SPECIALTY LEAGUE\n\nSimilar to regular leagues but for special sports.',
    'swim': 'SWIM\n\nPinned swim time. Automatically reserves the pool/swim area.',
    'lunch': 'LUNCH\n\nFixed lunch period. No scheduling occurs during this time.',
    'snacks': 'SNACKS\n\nFixed snack break.',
    'dismissal': 'DISMISSAL\n\nEnd of day marker.',
    'custom': 'CUSTOM PINNED\n\nCreate any fixed event (e.g., Assembly, Davening, Special Program).\n\nYou can reserve specific locations from your Locations settings.'
  };
  showAlert(descriptions[tile.type] || tile.description);
}

// =================================================================
// Color Softening Helper - Makes division colors match soft pastel palette
// =================================================================
function softenColor(hexColor) {
  if (!hexColor) return '#94a3b8';
  
  // Remove # if present
  let hex = hexColor.replace('#', '');
  
  // Handle shorthand hex (e.g., #fff)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  
  // Parse RGB
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);
  
  // If parsing failed, return a default soft color
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#94a3b8';
  
  // Soften by blending with white to create pastel effect
  // Mix with white at about 40% to match tile palette
  const mixRatio = 0.4;
  r = Math.round(r + (255 - r) * mixRatio);
  g = Math.round(g + (255 - g) * mixRatio);
  b = Math.round(b + (255 - b) * mixRatio);
  
  // Ensure values stay within bounds
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// --- Column Order ---
// ★ FN-50: the Camp Structure order (Campistry Me drag order) is the single
//   source of truth for grade columns. The old code preferred a saved
//   app1.manualColumnOrder — a stale alphabetical list from an earlier
//   session kept overriding the user's Me order.
function getColumnOrder() {
  const all = window.availableDivisions || [];
  return (typeof window.getUserDivisionOrder === 'function')
    ? window.getUserDivisionOrder([...all])
    : [...all];
}

function saveColumnOrder(order) {
  const g = window.loadGlobalSettings?.() || {};
  if (!g.app1) g.app1 = {};
  g.app1.manualColumnOrder = [...order];
  window.saveGlobalSettings?.('app1', g.app1);
  window.forceSyncToCloud?.();
}

// --- RENDER GRID ---
// Remove _swimChange skeleton tiles whose adjacent Swim / Swim+Elective is gone.
// Called from renderGrid so stale Change strips disappear automatically.
function msbCleanupOrphanChangeTiles() {
  if (!Array.isArray(dailySkeleton)) return;
  const before = dailySkeleton.length;
  dailySkeleton = dailySkeleton.filter(item => {
    if (!item || !item._swimChange) return true;
    const itemStart = parseTimeToMinutes(item.startTime);
    const itemEnd = parseTimeToMinutes(item.endTime);
    if (itemStart === null || itemEnd === null) return true;
    const hasMate = dailySkeleton.some(other => {
      if (!other || other === item) return false;
      if (other.division !== item.division) return false;
      const otherIsSwim = (other.type === 'pinned' && /^swim$/i.test(other.event || '')) ||
                          other.type === 'swim_elective';
      if (!otherIsSwim) return false;
      const os = parseTimeToMinutes(other.startTime);
      const oe = parseTimeToMinutes(other.endTime);
      if (os === null || oe === null) return false;
      if (item._swimChange === 'pre' && Math.abs(itemEnd - os) <= 30) return true;
      if (item._swimChange === 'post' && Math.abs(itemStart - oe) <= 30) return true;
      return false;
    });
    return hasMate;
  });
  if (dailySkeleton.length !== before) {
    console.log(`[MSB-CLEANUP] Removed ${before - dailySkeleton.length} orphan Change tile(s)`);
    if (typeof saveDraftToLocalStorage === 'function') saveDraftToLocalStorage();
  }
}

function renderGrid() {
  if (!grid) return;

  // Drop stale Change tiles before painting
  msbCleanupOrphanChangeTiles();

  // AUTO MODE: render DAW layer timeline instead of stacking grid
  if (builderMode === 'auto') {
      renderDAWGrid();
      return;
  }

  const divisions = window.divisions || {};
  const availableDivisions = getColumnOrder();

  if (availableDivisions.length === 0) {
    grid.innerHTML = `<div style="padding:40px;text-align:center;color:#64748b;font-size:13px;">
      No divisions found. Please go to Setup to create divisions.
    </div>`;
    return;
  }

  let earliestMin = null, latestMin = null;
  Object.values(divisions).forEach(div => {
    const s = parseTimeToMinutes(div.startTime);
    const e = parseTimeToMinutes(div.endTime);
    if (s !== null && (earliestMin === null || s < earliestMin)) earliestMin = s;
    if (e !== null && (latestMin === null || e > latestMin)) latestMin = e;
  });
  if (earliestMin === null) earliestMin = 540;
  if (latestMin === null) latestMin = 960;

  const latestPinned = Math.max(-Infinity, ...dailySkeleton.map(e => parseTimeToMinutes(e.endTime) || -Infinity));
  if (latestPinned > -Infinity) latestMin = Math.max(latestMin, latestPinned);
  if (latestMin <= earliestMin) latestMin = earliestMin + 60;

  const totalHeight = (latestMin - earliestMin) * PIXELS_PER_MINUTE;

  let html = `<div style="display:grid; grid-template-columns:50px repeat(${availableDivisions.length}, 1fr); position:relative; min-width:700px;">`;
    
  // Header
  html += `<div style="grid-row:1; position:sticky; top:0; background:#f8fafc; z-index:10; border-bottom:1px solid #e2e8f0; padding:10px 6px; font-weight:600; font-size:11px; color:#64748b;">Time</div>`;
  availableDivisions.forEach((divName, i) => {
    const rawColor = divisions[divName]?.color || '#475569';
    const color = softenColor(rawColor);
    html += `<div data-col-header="${divName}" draggable="true" style="grid-row:1; grid-column:${i+2}; position:sticky; top:0; background:${color}; color:#1e293b; z-index:10; border-bottom:1px solid ${color}; padding:10px 6px; text-align:center; font-weight:600; font-size:12px; cursor:grab; user-select:none;">${divName}</div>`;
  });

  // Time Column
  html += `<div style="grid-row:2; grid-column:1; height:${totalHeight}px; position:relative; background:#f8fafc; border-right:1px solid #e2e8f0;">`;
  for (let m = earliestMin; m < latestMin; m += INCREMENT_MINS) {
    const top = (m - earliestMin) * PIXELS_PER_MINUTE;
    html += `<div style="position:absolute; top:${top}px; left:0; width:100%; border-top:1px dashed #e2e8f0; font-size:10px; padding:2px 4px; color:#64748b;">${minutesToTime(m)}</div>`;
  }
  html += `</div>`;

  // Division Columns
  availableDivisions.forEach((divName, i) => {
    const div = divisions[divName];
    const s = parseTimeToMinutes(div?.startTime);
    const e = parseTimeToMinutes(div?.endTime);
      
    html += `<div class="grid-cell" data-div="${divName}" data-start-min="${earliestMin}" style="grid-row:2; grid-column:${i+2}; height:${totalHeight}px;">`;
      
    if (s !== null && s > earliestMin) {
      html += `<div class="grid-disabled" style="top:0; height:${(s - earliestMin) * PIXELS_PER_MINUTE}px;"></div>`;
    }
    if (e !== null && e < latestMin) {
      html += `<div class="grid-disabled" style="top:${(e - earliestMin) * PIXELS_PER_MINUTE}px; height:${(latestMin - e) * PIXELS_PER_MINUTE}px;"></div>`;
    }

    dailySkeleton.filter(ev => ev.division === divName).forEach(ev => {
      const start = parseTimeToMinutes(ev.startTime);
      const end = parseTimeToMinutes(ev.endTime);
      if (start != null && end != null && end > start) {
        const top = (start - earliestMin) * PIXELS_PER_MINUTE;
        const height = (end - start) * PIXELS_PER_MINUTE;
        html += renderEventTile(ev, top, height);
      }
    });
    
    html += `<div class="drop-preview"></div>`;
    html += `</div>`;
  });

  html += `</div>`;
  grid.innerHTML = html;
  grid.dataset.earliestMin = earliestMin;

  addColumnReorderListeners(grid);
  addDropListeners('.grid-cell');
  addDragToRepositionListeners(grid);
  addResizeListeners(grid);
  addClickToSelectListeners();
}



function addClickToSelectListeners() {
  grid.querySelectorAll('.grid-event').forEach(el => {
    let _downX, _downY, _clickTimer;
    el.addEventListener('mousedown', e => { _downX = e.clientX; _downY = e.clientY; });

    el.onclick = (e) => {
      if (e.target.classList.contains('resize-handle')) return;
      e.stopPropagation();
      const dist = Math.hypot(e.clientX - (_downX ?? e.clientX), e.clientY - (_downY ?? e.clientY));
      if (dist > 5) { selectTile(el.dataset.id); return; }
      clearTimeout(_clickTimer);
      _clickTimer = setTimeout(() => { editTile(el.dataset.id); }, 280);
    };

    el.ondblclick = async (e) => {
      e.stopPropagation();
      clearTimeout(_clickTimer);
      if (e.target.classList.contains('resize-handle')) return;
      await deleteTile(el.dataset.id);
    };
  });

  grid.onclick = (e) => {
    if (e.target.classList.contains('grid-cell') || e.target.id === 'scheduler-grid') {
      deselectAllTiles();
    }
  };
}

function addColumnReorderListeners(containerEl) {
  let dragSrc = null;
  const headers = () => containerEl.querySelectorAll('[data-col-header]');

  headers().forEach(hdr => {
    hdr.addEventListener('dragstart', e => {
      dragSrc = hdr.dataset.colHeader;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => { hdr.style.opacity = '0.4'; }, 0);
    });
    hdr.addEventListener('dragend', () => {
      hdr.style.opacity = '';
      headers().forEach(h => h.style.outline = '');
    });
    hdr.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    hdr.addEventListener('dragenter', e => {
      e.preventDefault();
      headers().forEach(h => h.style.outline = '');
      if (hdr.dataset.colHeader !== dragSrc) hdr.style.outline = '2px dashed #3b82f6';
    });
    hdr.addEventListener('dragleave', () => { hdr.style.outline = ''; });
    hdr.addEventListener('drop', e => {
      e.preventDefault();
      hdr.style.outline = '';
      if (!dragSrc || dragSrc === hdr.dataset.colHeader) return;
      const order = getColumnOrder();
      const from = order.indexOf(dragSrc);
      const to = order.indexOf(hdr.dataset.colHeader);
      if (from === -1 || to === -1) return;
      order.splice(from, 1);
      order.splice(to, 0, dragSrc);
      saveColumnOrder(order);
      renderGrid();
    });
  });
}

// --- Render Tile ---
function renderEventTile(ev, top, height) {
  let tile = TILES.find(t => t.name === ev.event);
  if (!tile && ev.type) tile = TILES.find(t => t.type === ev.type);
  // ★ v2.5: Match DA's fallback logic for slot-type events that don't match by name/type
  if (!tile) {
    if (ev.event === 'General Activity Slot') tile = TILES.find(t => t.type === 'activity');
    else if (ev.event === 'Sports Slot') tile = TILES.find(t => t.type === 'sports');
    else if (ev.event === 'Special Activity') tile = TILES.find(t => t.type === 'special');
    else tile = TILES.find(t => t.type === 'custom');
  }
  let style = tile ? tile.style : 'background:#d1d5db;color:#374151;';
  // ★ Guaranteed-swap Smart tiles get a distinct teal (unused by any other tile)
  //   so the mode is obvious and doesn't clash with the Split tile's purple (#c4b5fd).
  if (ev.type === 'smart' && ev.smartData && ev.smartData.guaranteeSwap) {
    style = 'background:#5eead4;color:#115e59;border:2px solid #14b8a6;';
  }
  // ★ Connected smart tiles (same pairGroup) get a matching colored glow so you can
  //   see at a glance which two tiles swap together.
  if (ev.type === 'smart' && ev.smartData && ev.smartData.pairGroup) {
    const _gc = { '1': '#f59e0b', '2': '#3b82f6', '3': '#10b981', '4': '#a855f7' }[String(ev.smartData.pairGroup)] || '#f59e0b';
    style += ';box-shadow:0 0 0 3px ' + _gc + ', 0 0 9px ' + _gc + ';';
  }
  
  // Add 1px gap at bottom to prevent overlap with next tile
  const adjustedHeight = Math.max(height - 1, 10);
  
  let innerHtml = `
    <div class="tile-header">
      <strong style="font-size:11px;">${_mbEsc(ev.event)}</strong>
      <div style="font-size:10px;opacity:0.9;">${_mbEsc(ev.startTime)}-${_mbEsc(ev.endTime)}</div>
    </div>
  `;

  if (ev.location) {
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">📍 ${_mbEsc(ev.location)}</div>`;
  } else if (ev.reservedFields?.length > 0 && ev.type !== 'elective') {
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">📍 ${ev.reservedFields.map(_mbEsc).join(', ')}</div>`;
  }


  if (ev.leagueName) {
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">${_mbEsc(ev.leagueName)}</div>`;
  }
  if ((ev.type === 'league' || ev.type === 'specialty_league') && ev.leagueName) {
    const _gs = window.loadGlobalSettings?.() || {};
    const _lObj = (_gs.leaguesByName || {})[ev.leagueName];
    if (_lObj?.offCampus?.enabled && _mbIsBackToBack(ev)) {
      innerHtml += `<div style="font-size:9px;font-weight:600;color:#1e40af;background:#dbeafe;display:inline-block;padding:1px 5px;border-radius:4px;margin-top:2px;">AWAY PAIR</div>`;
    }
  }

  if (ev.type === 'elective' && ev.electiveActivities?.length > 0) {
    const actList = ev.electiveActivities.slice(0, 3).map(_mbEsc).join(', ');
    const more = ev.electiveActivities.length > 3 ? ` +${ev.electiveActivities.length - 3}` : '';
    innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">🎯 ${actList}${more}</div>`;
  }

  // ★ Swim + Elective hybrid badges
  if (ev.type === 'swim_elective') {
    const _seActs = ev.electiveActivities || [];
    if (_seActs.length > 0) {
      const _seList = _seActs.slice(0, 3).map(_mbEsc).join(', ');
      const _seMore = _seActs.length > 3 ? ` +${_seActs.length - 3}` : '';
      innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">${_mbEsc(ev.swimLocation || 'Pool')} + ${_seList}${_seMore}</div>`;
    } else {
      innerHtml += `<div style="font-size:9px;opacity:0.85;margin-top:2px;">${_mbEsc(ev.swimLocation || 'Pool')} + Elective</div>`;
    }
    if (ev._preChangeMin || ev._postChangeMin) {
      const _sePre = ev._preChangeMin || 0;
      const _sePost = ev._postChangeMin || 0;
      const _seLbl = _sePre === _sePost ? _sePre + 'm' : _sePre + 'm / ' + _sePost + 'm';
      innerHtml += `<div style="font-size:9px;font-weight:600;color:#155e75;background:#cffafe;display:inline-block;padding:1px 5px;border-radius:4px;margin-top:2px;">CHANGE ${_seLbl}</div>`;
    }
  }

  if (ev.type === 'smart' && ev.smartData) {
    if (ev.smartData.guaranteeSwap) {
      innerHtml += `<div style="font-size:9px;font-weight:700;margin-top:2px;">⇄ ${_mbEsc(ev.smartData.main1)} ↔ ${_mbEsc(ev.smartData.main2)} · all get both</div>`;
    } else {
      innerHtml += `<div style="font-size:9px;opacity:0.8;margin-top:2px;">Fallback: ${_mbEsc(ev.smartData.fallbackActivity)}</div>`;
    }
  }
  
  // ★ v2.5: Show split tile sub-events
  if (ev.type === 'split' && ev.subEvents?.length === 2) {
    innerHtml += `<div style="font-size:9px;opacity:0.8;margin-top:2px;">↔ ${ev.subEvents[0].event} / ${ev.subEvents[1].event}</div>`;
  }
  if (ev.type === 'split' && ev.group1Bunks?.length) {
    innerHtml += `<div style="font-size:9px;font-weight:600;color:#1e40af;background:#dbeafe;display:inline-block;padding:1px 5px;border-radius:4px;margin-top:2px;">custom groups</div>`;
  }
  // Split tile with swim → show change badge
  if (ev.type === 'split' && (ev._preChangeMin || ev._postChangeMin)) {
    const _pre = ev._preChangeMin || 0;
    const _post = ev._postChangeMin || 0;
    const _lbl = _pre === _post ? _pre + 'm' : _pre + 'm / ' + _post + 'm';
    innerHtml += `<div style="font-size:9px;font-weight:600;color:#155e75;background:#cffafe;display:inline-block;padding:1px 5px;border-radius:4px;margin-top:2px;">CHANGE ${_lbl}</div>`;
  }
  const selectedClass = selectedTileId === ev.id ? ' selected' : '';

  // Travel strips (off-campus). Prefer stamped values; fall back to live zone lookup (manual = deduct mode).
  const _travelStrips = (function() {
    let pre = parseInt(ev._travelPre) || 0;
    let post = parseInt(ev._travelPost) || 0;
    let zone = ev._travelZone || '';
    if (!pre && !post) {
      const locName = ev.location || (Array.isArray(ev.reservedFields) && ev.reservedFields[0]) || '';
      const info = locName ? (window.getTravelForField?.(locName, true) || window.getTravelForSpecialActivity?.(locName, true)) : null;
      if (info) { pre = info.preMin; post = info.postMin; zone = info.zoneName; }
    }
    let html = '';
    if (pre > 0) {
      html += `<div title="Travel to ${zone}: ${pre} min" style="position:absolute;top:0;left:0;right:0;height:${adjustedHeight>=28?8:6}px;background:repeating-linear-gradient(45deg,#F59E0B,#F59E0B 4px,#FCD34D 4px,#FCD34D 8px);border-bottom:1px solid #B45309;pointer-events:none;text-align:center;font-size:0.55rem;line-height:8px;color:#78350F;font-weight:700;">${adjustedHeight>=28?('🚐 '+pre+'m'):''}</div>`;
    }
    if (post > 0) {
      html += `<div title="Travel from ${zone}: ${post} min" style="position:absolute;bottom:0;left:0;right:0;height:${adjustedHeight>=28?8:6}px;background:repeating-linear-gradient(45deg,#F59E0B,#F59E0B 4px,#FCD34D 4px,#FCD34D 8px);border-top:1px solid #B45309;pointer-events:none;text-align:center;font-size:0.55rem;line-height:8px;color:#78350F;font-weight:700;">${adjustedHeight>=28?('🚐 '+post+'m'):''}</div>`;
    }
    return html;
  })();

  return `<div class="grid-event${selectedClass}" data-id="${ev.id}" draggable="true" title="Click to select, Delete key to remove"
          style="${style}; position:absolute; top:${top}px; height:${adjustedHeight}px; width:96%; left:2%; padding:5px 7px; font-size:11px; overflow:hidden; border-radius:5px; cursor:pointer; display:flex; flex-direction:column; box-sizing:border-box;">
          <div class="resize-handle resize-handle-top"></div>
          ${innerHtml}
          ${_travelStrips}
          <div class="resize-handle resize-handle-bottom"></div>
          </div>`;
}

// --- Drop Listeners ---
function addDropListeners(selector) {
  grid.querySelectorAll(selector).forEach(cell => {
    cell.ondragover = e => { e.preventDefault(); cell.style.background = '#ecfdf5'; };
    cell.ondragleave = e => { cell.style.background = ''; };
    cell.ondrop = async e => {
      e.preventDefault();
      cell.style.background = '';

      // Handle moving existing tiles
      if (e.dataTransfer.types.includes('text/event-move')) {
        const eventId = e.dataTransfer.getData('text/event-move');
        const event = dailySkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const divName = cell.dataset.div;
        const cellStartMin = parseInt(cell.dataset.startMin, 10);
        const rect = cell.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
        
        const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
        const newStart = minutesToTime(cellStartMin + snapMin);
        const newEnd = minutesToTime(cellStartMin + snapMin + duration);

        if (divName !== event.division) {
          // Cross-grade drop. Clone the event, retarget the division, and
          // remap any league reference to one assigned to the new grade so
          // it doesn't keep pointing at the source grade's league.
          const _crossEv = { ...event, id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 5), division: divName, startTime: newStart, endTime: newEnd };
          _mbRemapLeagueForGrade(_crossEv, divName);
          dailySkeleton.push(_crossEv);
        } else {
          event.startTime = newStart;
          event.endTime = newEnd;
        }

        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
        return;
      }

      const tileData = JSON.parse(e.dataTransfer.getData('application/json'));
      const divName = cell.dataset.div;
      const earliestMin = parseInt(cell.dataset.startMin);
      
      const rect = cell.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      
      let minOffset = Math.round(offsetY / PIXELS_PER_MINUTE / 15) * 15;
      let startMin = earliestMin + minOffset;
      let endMin = startMin + INCREMENT_MINS;
      
      const startStr = minutesToTime(startMin);
      const endStr = minutesToTime(endMin);

      let newEvent = null;
      
      // SMART TILE
      if (tileData.type === 'smart') {
        const result = await showModal({
          title: 'Smart Tile Setup',
          description: 'Fills Main 1 based on capacity, rest get Main 2. Next period they swap. If Main 1 is full, Fallback is used.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am' },
            { name: 'main1', label: 'Main 1 (limited capacity)', type: 'text', placeholder: 'e.g., Special, Swim — or a specific one: Lake' },
            { name: 'main2', label: 'Main 2 (everyone else)', type: 'text', placeholder: 'e.g., Sports, Activity — or specific: Pickleball' },
            { name: 'fallbackActivity', label: 'Fallback (when Main 1 is full)', type: 'text', default: 'Activity', placeholder: 'e.g., Activity, Sports — or specific: Pickleball' },
            { name: 'pairGroup', label: 'Connect with (pair group)', type: 'select', default: '', options: [{ value: '', label: 'Auto — pair by time order' }, { value: '1', label: '🔶 Group 1' }, { value: '2', label: '🔷 Group 2' }, { value: '3', label: '🟩 Group 3' }, { value: '4', label: '🟪 Group 4' }] }
          ],
          postRender: (overlay) => _mbSmartSwapPostRender(overlay, false)
        });
        if (!result || !result.main1 || !result.main2) return;
        const _gsOn = result.guaranteeSwap === 'true';

        newEvent = {
          id: Date.now().toString(),
          type: 'smart',
          event: `${result.main1} / ${result.main2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          smartData: { main1: result.main1, main2: result.main2, fallbackFor: result.main1, fallbackActivity: _gsOn ? result.main2 : (result.fallbackActivity || 'Activity'), guaranteeSwap: _gsOn, pairGroup: result.pairGroup || null }
        };
      }
      // ★ v2.5: SPLIT TILE - Fixed to match daily adjustments (Main 1/Main 2 + mapEventNameForOptimizer)
      else if (tileData.type === 'split') {
        const result = await showModal({
          title: 'Split Activity Setup',
          description: 'Splits division into two groups. Midway through the time block, groups SWAP.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am' },
            { name: 'main1', label: 'Main 1 (Group 1 starts here)', type: 'text', placeholder: 'e.g., Swim, Sports, Art' },
            { name: 'main2', label: 'Main 2 (Group 2 starts here)', type: 'text', placeholder: 'e.g., Sports, Special, Activity' }
          ],
          postRender: function(overlay) {
            const main1Input = overlay.querySelector('[data-field="main1"]');
            const main2Input = overlay.querySelector('[data-field="main2"]');
            const changeWrap = document.createElement('div');
            changeWrap.id = 'split-change-fields';
            changeWrap.style.cssText = 'display:none;margin-top:12px;padding:12px;background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;';
            changeWrap.innerHTML = '<div style="font-size:11px;font-weight:600;color:#155e75;margin-bottom:8px;">Swim Change Time</div>'
              + '<div style="display:flex;gap:12px;">'
              + '<div style="flex:1;"><label style="font-size:11px;color:#64748b;">Pre-Change (minutes)</label><input type="text" data-field="preChangeMin" placeholder="e.g., 5" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;"></div>'
              + '<div style="flex:1;"><label style="font-size:11px;color:#64748b;">Post-Change (minutes)</label><input type="text" data-field="postChangeMin" placeholder="e.g., 5" style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;"></div>'
              + '</div>';
            const fieldsContainer = overlay.querySelector('.ms-modal-fields') || overlay.querySelector('[class*="fields"]') || overlay.querySelector('[class*="body"]');
            if (fieldsContainer) fieldsContainer.appendChild(changeWrap);

            function checkSwim() {
              const v1 = (main1Input?.value || '').toLowerCase().trim();
              const v2 = (main2Input?.value || '').toLowerCase().trim();
              const hasSwim = v1 === 'swim' || v2 === 'swim' || v1.includes('swim') || v2.includes('swim');
              changeWrap.style.display = hasSwim ? 'block' : 'none';
            }
            if (main1Input) main1Input.addEventListener('input', checkSwim);
            if (main2Input) main2Input.addEventListener('input', checkSwim);
            checkSwim();
            _buildSplitBunkPicker(overlay, divName, null);
          }
        });
        if (!result || !result.main1 || !result.main2) return;

        // Map through optimizer (same as daily adjustments) to get proper type+event structure
        const event1 = mapEventNameForOptimizer(result.main1);
        const event2 = mapEventNameForOptimizer(result.main2);

        // Detect if either activity is swim → store change times
        const splitHasSwim = result.main1.toLowerCase().trim().includes('swim') || result.main2.toLowerCase().trim().includes('swim');
        const mbSplitPre = splitHasSwim ? (parseInt(result.preChangeMin) || 0) : 0;
        const mbSplitPost = splitHasSwim ? (parseInt(result.postChangeMin) || 0) : 0;
        const mbSplitStart = parseTimeToMinutes(result.startTime);
        const mbSplitEnd = parseTimeToMinutes(result.endTime);
        const halfDur = Math.floor((mbSplitEnd - mbSplitStart) / 2);

        if ((mbSplitPre + mbSplitPost) >= halfDur) {
          await showAlert('Change time (' + (mbSplitPre + mbSplitPost) + ' min) must be less than each half (' + halfDur + ' min).');
          return;
        }

        newEvent = {
          id: Date.now().toString(),
          type: 'split',
          event: `${result.main1} / ${result.main2}`,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          subEvents: [
            { ...event1, event: event1.event || result.main1 },
            { ...event2, event: event2.event || result.main2 }
          ],
          _preChangeMin: mbSplitPre || undefined,
          _postChangeMin: mbSplitPost || undefined,
          group1Bunks: result.group1Bunks ? JSON.parse(result.group1Bunks) : null
        };

        console.log(`[SPLIT TILE] Created split tile for ${divName}:`, newEvent.subEvents, (mbSplitPre || mbSplitPost) ? '(change: ' + mbSplitPre + 'pre/' + mbSplitPost + 'post)' : '');
      }
      // ELECTIVE
      else if (tileData.type === 'elective') {
        const locations = getAllLocations();
        if (locations.length === 0) {
          await showAlert('No locations configured. Please set up fields/facilities first.');
          return;
        }
        const taken = getConflictingFacilities(startStr, endStr, null);
        const sportMap = getSportFacilitiesMap();
        const sportOptions = [{ value: '', label: '— Pick a sport to auto-assign facility —' }, ...Object.keys(sportMap).sort().map(s => ({ value: s, label: s }))];
        const locationOptions = locations.map(l => taken.has(l) ? { value: l, label: l, disabled: true, disabledReason: 'Already reserved at this time' } : l);
        const result = await showModal({
          title: `Elective for ${divName}`,
          description: 'Select activities to RESERVE for this division only. Other divisions cannot use these during this time.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:30am', default: endStr },
            ...(sportOptions.length > 1 ? [{ name: 'sport', label: 'Sport (auto-assign facility)', type: 'select', options: sportOptions }] : []),
            { name: 'activities', label: 'Reserve Locations', type: 'checkbox-group', options: locationOptions }
          ],
          postRender: (overlay) => {
            const sportSel = overlay.querySelector('[data-field="sport"]');
            if (!sportSel) return;
            sportSel.addEventListener('change', () => {
              const s = sportSel.value;
              const matching = s ? (sportMap[s] || []) : [];
              overlay.querySelectorAll('input[data-group="activities"]:not(:disabled)').forEach(cb => {
                cb.checked = matching.includes(cb.value);
              });
            });
          }
        });
        if (!result) return;
        let chosen = result.activities || [];
        if (result.sport && chosen.length === 0) chosen = (sportMap[result.sport] || []).filter(f => !taken.has(f));
        if (!chosen.length) return;
        const eventName = 'Elective';
        newEvent = {
          id: Date.now().toString(),
          type: 'elective',
          event: eventName,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          electiveActivities: chosen,
          reservedFields: chosen
        };
      }
      // ★ SWIM + ELECTIVE HYBRID — direct drop from palette
      else if (tileData.type === 'swim_elective') {
        const locations = getAllLocations();
        if (locations.length === 0) {
          await showAlert('No locations configured. Please set up fields/facilities first.');
          return;
        }
        // Pick a default pool location (same logic as swim tile)
        let defaultPool = window.getPinnedTileDefaultLocation?.('swim') || null;
        if (!defaultPool) {
          const _gs = window.loadGlobalSettings?.() || {};
          const _f = (_gs.app1?.fields || []).find(f => /\b(swim|pool)\b/i.test(f.name));
          if (_f) defaultPool = _f.name;
        }
        const taken = getConflictingFacilities(startStr, endStr, null);
        const sportMap = getSportFacilitiesMap();
        const sportOptions = [{ value: '', label: '— Pick a sport to auto-assign facility —' }, ...Object.keys(sportMap).sort().map(s => ({ value: s, label: s }))];
        // Exclude the pool from elective options (it's already implicit)
        const electiveLocOptions = locations
          .filter(l => l !== defaultPool)
          .map(l => taken.has(l) ? { value: l, label: l, disabled: true, disabledReason: 'Already reserved at this time' } : l);
        const result = await showModal({
          title: `Swim + Elective for ${divName}`,
          description: 'Hybrid: pool reserved + listed activities reserved at the same time. Campers choose individually.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am', default: startStr },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am', default: endStr },
            { name: 'preChangeMin', label: 'Pre-Change (minutes, optional)', type: 'text', placeholder: 'e.g., 5' },
            { name: 'postChangeMin', label: 'Post-Change (minutes, optional)', type: 'text', placeholder: 'e.g., 5' },
            ...(sportOptions.length > 1 ? [{ name: 'sport', label: 'Sport (auto-assign facility)', type: 'select', options: sportOptions }] : []),
            { name: 'activities', label: 'Reserve Locations (electives)', type: 'checkbox-group', options: electiveLocOptions }
          ],
          postRender: (overlay) => {
            const sportSel = overlay.querySelector('[data-field="sport"]');
            if (!sportSel) return;
            sportSel.addEventListener('change', () => {
              const s = sportSel.value;
              const matching = s ? (sportMap[s] || []) : [];
              overlay.querySelectorAll('input[data-group="activities"]:not(:disabled)').forEach(cb => {
                cb.checked = matching.includes(cb.value);
              });
            });
          }
        });
        if (!result) return;
        let chosen = result.activities || [];
        if (result.sport && chosen.length === 0) chosen = (sportMap[result.sport] || []).filter(f => !taken.has(f) && f !== defaultPool);
        if (!chosen.length) {
          await showAlert('Pick at least one elective activity to reserve.');
          return;
        }
        const _hPre = parseInt(result.preChangeMin) || 0;
        const _hPost = parseInt(result.postChangeMin) || 0;
        newEvent = {
          id: Date.now().toString(),
          type: 'swim_elective',
          event: 'Swim + Elective',
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          _preChangeMin: _hPre || undefined,
          _postChangeMin: _hPost || undefined,
          swimLocation: defaultPool,
          electiveActivities: chosen,
          reservedFields: Array.from(new Set([...(defaultPool ? [defaultPool] : []), ...chosen]))
        };
      }
      // ★ FN-48: GENERAL-ACTIVITY tile — the name + facility come pre-bound
      //   from the facilities registry; only the time window is asked
      //   (mirrors the swim/lunch flow).
      else if (tileData.type === 'custom' && tileData.gaName) {
        const result = await showModal({
          title: tileData.gaName,
          description: 'Pinned at ' + (tileData.gaFacility || 'its facility') + '. Set the time window for ' + divName + '.',
          fields: [
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
          ]
        });
        if (!result) return;
        const _gaFlds = tileData.gaFacility ? [tileData.gaFacility] : [];
        newEvent = {
          id: Date.now().toString(),
          type: 'pinned',
          event: tileData.gaName,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          reservedFields: _gaFlds,
          location: tileData.gaFacility || null
        };
      }
      // ★ v2.5: CUSTOM PINNED - Now uses grouped locations from locationZones (matches DA bunk overrides)
      else if (tileData.type === 'custom') {
        const { groups: locationGroups, hasAny: hasLocations } = getGroupedLocationOptions();
        
        // Build modal fields
        const modalFields = [
          { name: 'eventName', label: 'Event Name', type: 'text', default: '', placeholder: 'e.g., Regroup, Assembly, Davening' },
          { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
          { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
        ];
        
        // Add grouped locations if available
        if (hasLocations) {
          modalFields.push({ name: 'reservedFields', label: 'Reserve Locations (optional)', type: 'grouped-checkbox', groups: locationGroups });
        }
        
        const result = await showModal({
          title: 'Custom Pinned Event',
          description: hasLocations 
            ? 'Create a fixed event. Optionally reserve locations from your setup.'
            : 'Create a fixed event. (No locations found — add them in Setup → Location Zones)',
          fields: modalFields
        });
        if (!result || !result.eventName?.trim()) {
          if (result) await showAlert('Please enter an event name.');
          return;
        }
        
        const reservedFields = result.reservedFields || [];
        newEvent = {
          id: Date.now().toString(),
          type: 'pinned',
          event: result.eventName.trim(),
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime,
          reservedFields: reservedFields,
          location: reservedFields.length === 1 ? reservedFields[0] : null
        };
      }
     // OTHER PINNED (swim, lunch, snacks, dismissal)
      else if (['lunch', 'snacks', 'dismissal', 'swim'].includes(tileData.type)) {
        let name = tileData.name;
        let reservedFields = [];
        let location = window.getPinnedTileDefaultLocation?.(tileData.type) || null;
        
        if (location) reservedFields = [location];
        
        if (tileData.type === 'swim' && reservedFields.length === 0) {
          const globalSettings = window.loadGlobalSettings?.() || {};
          const fields = globalSettings.app1?.fields || [];
          const swimField = fields.find(f => 
            /\bswim\b/i.test(f.name) || /\bpool\b/i.test(f.name)
          );
          if (swimField) {
            reservedFields = [swimField.name];
            location = swimField.name;
          }
        }
        
        const swimModalFields = [
          { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
          { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
        ];
        if (tileData.type === 'swim') {
          swimModalFields.push(
            { name: 'preChangeMin', label: 'Pre-Change (minutes, optional)', type: 'text', placeholder: 'e.g., 10' },
            { name: 'postChangeMin', label: 'Post-Change (minutes, optional)', type: 'text', placeholder: 'e.g., 10' }
          );
        }
        // Grade Mode toggle for swim / lunch / snacks
        if (['swim', 'lunch', 'snacks'].includes(tileData.type)) {
          swimModalFields.push({
            name: 'gradeMode',
            label: 'Grade Mode',
            type: 'select',
            options: [
              { value: 'stagger', label: 'Staggered — bunks at different times' },
              { value: 'fullgrade', label: 'Full Grade — all bunks at the same time (like a league)' }
            ]
          });
        }

        const result = await showModal({
          title: name,
          description: tileData.type === 'swim' ? 'Change time is carved from the total block. e.g. 3–4 with 10min changes → Change 3:00–3:10, Swim 3:10–3:50, Change 3:50–4:00' : undefined,
          fields: swimModalFields
        });
        if (!result) return;
        
        const msTotalStart = parseTimeToMinutes(result.startTime);
        const msTotalEnd = parseTimeToMinutes(result.endTime);
        const msPreChange = (tileData.type === 'swim') ? (parseInt(result.preChangeMin) || 0) : 0;
        const msPostChange = (tileData.type === 'swim') ? (parseInt(result.postChangeMin) || 0) : 0;
        
        if (msPreChange + msPostChange >= (msTotalEnd - msTotalStart)) {
          await showAlert('Change time (' + (msPreChange + msPostChange) + ' min) must be less than the total block (' + (msTotalEnd - msTotalStart) + ' min).');
          return;
        }
        
        const msSwimStart = msTotalStart + msPreChange;
        const msSwimEnd = msTotalEnd - msPostChange;
        
        // Pre-Change carved from start of block
        if (msPreChange > 0) {
          dailySkeleton.push({
            id: Date.now().toString() + '_prechange',
            type: 'pinned',
            event: 'Change',
            division: divName,
            startTime: result.startTime,
            endTime: minutesToTime(msSwimStart),
            reservedFields: [],
            location: null,
            _swimChange: 'pre'
          });
        }
        
        // Swim tile — narrowed to exclude change time
        const _swimFullGrade = result.gradeMode === 'fullgrade';
        newEvent = {
          id: Date.now().toString(),
          type: 'pinned',
          event: name,
          division: divName,
          startTime: minutesToTime(msSwimStart),
          endTime: minutesToTime(msSwimEnd),
          reservedFields: reservedFields,
          location: location,
          _preChangeMin: msPreChange || undefined,
          _postChangeMin: msPostChange || undefined,
          fullGrade: _swimFullGrade || undefined
        };
        
        // Post-Change carved from end of block
        if (msPostChange > 0) {
          dailySkeleton.push({
            id: Date.now().toString() + '_postchange',
            type: 'pinned',
            event: 'Change',
            division: divName,
            startTime: minutesToTime(msSwimEnd),
            endTime: result.endTime,
            reservedFields: [],
            location: null,
            _swimChange: 'post'
          });
        }
      }
      // STANDARD SLOTS & LEAGUES
      else {
        let name = tileData.name;
        let finalType = tileData.type;

        if (tileData.type === 'activity') { name = "General Activity Slot"; finalType = 'slot'; }
        else if (tileData.type === 'sports') { name = "Sports Slot"; finalType = 'slot'; }
        else if (tileData.type === 'special') { name = "Special Activity"; finalType = 'slot'; }
        else if (tileData.type === 'league') { name = "League Game"; finalType = 'league'; }
        else if (tileData.type === 'specialty_league') { name = "Specialty League"; finalType = 'specialty_league'; }
        
        // ★★★ MULTIPLE LEAGUE SUPPORT: Build league picker for league tiles ★★★
        // Filter to leagues assigned to THIS grade. If exactly one matches,
        // skip the picker entirely and auto-assign it. If more than one,
        // require an explicit pick. If none, block the drop.
        let leaguePickerField = [];
        let _autoLeagueName = null;
        if (tileData.type === 'league') {
          const _gs = window.loadGlobalSettings?.() || {};
          const _lbn = _gs.leaguesByName || {};
          const _gradeLeagues = Object.keys(_lbn).filter(ln =>
            _lbn[ln] && _lbn[ln].enabled !== false &&
            Array.isArray(_lbn[ln].divisions) &&
            _lbn[ln].divisions.includes(String(divName))
          );
          if (_gradeLeagues.length === 0) {
            // No leagues configured for this grade — block the drop.
            await showAlert('No leagues are assigned to ' + divName + '. Add this grade to a league in League Setup before dropping a league tile here.');
            return;
          } else if (_gradeLeagues.length === 1) {
            // Only one league for this grade → use it silently.
            _autoLeagueName = _gradeLeagues[0];
          } else {
            // Multiple leagues → require pick.
            leaguePickerField = [{
              name: 'leagueName',
              label: 'Which League? (required)',
              type: 'select',
              options: [{ value: '', label: '— Choose a league —' }].concat(
                _gradeLeagues.map(ln => ({ value: ln, label: ln }))
              ),
              default: ''
            }];
          }
        }

        // ★ Subcategory picker for Special Activity blocks. Lets the user
        //   tag this block "Food" / "Theme" / etc so the scheduler will only
        //   fill it with a matching special. Empty = any special.
        let subcategoryField = [];
        if (tileData.type === 'special') {
          const _subOptions = (typeof window.getSpecialSubcategories === 'function')
            ? window.getSpecialSubcategories() : [];
          subcategoryField = [{
            name: 'subcategory',
            label: 'Subcategory',
            type: 'select',
            options: [{ value: '', label: '— Any —' }]
              .concat(_subOptions.map(s => ({ value: s, label: s })))
              .concat([{ value: '__add_new__', label: '+ New subcategory…' }]),
            default: ''
          }];
        }

        const result = await showModal({
          title: name,
          fields: [
            ...leaguePickerField,
            ...subcategoryField,
            { name: 'startTime', label: 'Start Time', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'endTime', label: 'End Time', type: 'text', placeholder: 'e.g., 11:45am' }
          ],
          postRender: (overlay) => {
            const sel = overlay.querySelector('select[data-field="subcategory"]');
            if (!sel) return;
            sel.addEventListener('change', () => {
              if (sel.value !== '__add_new__') return;
              const newName = (window.prompt('New subcategory name (e.g. Food, Theme):') || '').trim();
              if (!newName) { sel.value = ''; return; }
              if (typeof window.addSpecialSubcategory === 'function') window.addSpecialSubcategory(newName);
              const addOpt = sel.querySelector('option[value="__add_new__"]');
              const exists = Array.from(sel.options).some(o => o.value.toLowerCase() === newName.toLowerCase());
              if (!exists) {
                const opt = document.createElement('option');
                opt.value = newName; opt.textContent = newName;
                sel.insertBefore(opt, addOpt);
              }
              sel.value = newName;
            });
          }
        });
        if (!result) return;

        // ★ Require an explicit league selection for league tiles when
        //   the picker was shown (multi-league grade). Single-league
        //   grades skip the picker and use _autoLeagueName below.
        if (finalType === 'league' && leaguePickerField.length > 0 && !result.leagueName) {
          await showAlert('Please choose a league before dropping the tile.');
          return;
        }
        if (finalType === 'league' && _autoLeagueName) {
          result.leagueName = _autoLeagueName;
        }

        newEvent = {
          id: Date.now().toString(),
          type: finalType,
          event: name,
          division: divName,
          startTime: result.startTime,
          endTime: result.endTime
        };

        // ★ Persist subcategory tag so the scheduler can filter specials.
        if (tileData.type === 'special' && result.subcategory && result.subcategory !== '__add_new__') {
          newEvent.subcategory = String(result.subcategory).trim();
        }

        // ★★★ MULTIPLE LEAGUE SUPPORT: Store selected league name ★★★
        if (finalType === 'league' && result.leagueName) {
          newEvent.leagueName = result.leagueName;
          newEvent.event = result.leagueName;
        }
      }

      if (newEvent) {
        // ★ SWIM + ELECTIVE MERGE — prompt to combine when dropping one over the other
        const _mergeRes = await tryMergeSwimElective(newEvent, divName, dailySkeleton);
        if (_mergeRes) {
          // Remove the overlapping complementary tile
          dailySkeleton = dailySkeleton.filter(ev => ev.id !== _mergeRes.overlapId);
          // Remove pre/post change tiles that belong to the swim being merged
          const swimSt = parseTimeToMinutes(_mergeRes.swimEvent.startTime);
          const swimEt = parseTimeToMinutes(_mergeRes.swimEvent.endTime);
          dailySkeleton = dailySkeleton.filter(ev => {
            if (!ev._swimChange) return true;
            if (ev.division !== divName) return true;
            const evS = parseTimeToMinutes(ev.startTime);
            const evE = parseTimeToMinutes(ev.endTime);
            if (evS === null || evE === null) return true;
            if (ev._swimChange === 'pre' && Math.abs(evE - swimSt) <= 30) return false;
            if (ev._swimChange === 'post' && Math.abs(evS - swimEt) <= 30) return false;
            return true;
          });
          // Replace newEvent with the hybrid layer
          newEvent = _mergeRes.hybrid;
        }

        const newStartVal = parseTimeToMinutes(newEvent.startTime);
        const newEndVal = parseTimeToMinutes(newEvent.endTime);

        // ★ EARLY/LATE TILE GUARD — flag tiles outside 8am-8pm
        // Exception: skip if the division's own time range covers the time
        const GUARD_START = 480;  // 8:00 AM
        const GUARD_END = 1200;   // 8:00 PM
        const guardDiv = (window.divisions || {})[divName] || {};
        const guardDivStart = parseTimeToMinutes(guardDiv.startTime);
        const guardDivEnd = parseTimeToMinutes(guardDiv.endTime);
        const hasDivTimes = (guardDivStart !== null && guardDivEnd !== null);

        const startOutside = newStartVal !== null && (newStartVal < GUARD_START || newStartVal > GUARD_END);
        const endOutside = newEndVal !== null && (newEndVal < GUARD_START || newEndVal > GUARD_END);
        const startCovered = hasDivTimes && newStartVal >= guardDivStart && newStartVal <= guardDivEnd;
        const endCovered = hasDivTimes && newEndVal >= guardDivStart && newEndVal <= guardDivEnd;

        if ((startOutside && !startCovered) || (endOutside && !endCovered)) {
          const ok = await showConfirm(
            `⚠️ This tile (${newEvent.startTime} – ${newEvent.endTime}) has times outside normal camp hours (8:00 AM – 8:00 PM).\n\nJust confirming — is this tile correct?`
          );
          if (!ok) return;
        }

        // Remove overlapping events
        dailySkeleton = dailySkeleton.filter(existing => {
          if (existing.division !== divName) return true;
          const exStart = parseTimeToMinutes(existing.startTime);
          const exEnd = parseTimeToMinutes(existing.endTime);
          if (exStart === null || exEnd === null) return true;
          const overlaps = (exStart < newEndVal) && (exEnd > newStartVal);
          return !overlaps;
        });

        // Stamp travel info for off-campus facilities
        const _travelLoc = newEvent.location || (Array.isArray(newEvent.reservedFields) && newEvent.reservedFields[0]) || '';
        if (_travelLoc) {
          const _ti = window.getTravelForField?.(_travelLoc, true) || window.getTravelForSpecialActivity?.(_travelLoc, true);
          if (_ti) {
            newEvent._travelPre = _ti.preMin;
            newEvent._travelPost = _ti.postMin;
            newEvent._travelZone = _ti.zoneName;
            newEvent._travelMode = _ti.mode;
          }
        }

        // Soft cooldown check for manual-mode rules
        if (window.SchedulingRules) {
          const _cdLoc = newEvent.location || (Array.isArray(newEvent.reservedFields) && newEvent.reservedFields[0]) || null;
          const _cdCandidate = {
            startMin: newStartVal, endMin: newEndVal,
            type: window.SchedulingRules.inferTypeFromActivity(newEvent.event || ''),
            event: newEvent.event || '', field: _cdLoc
          };
          const _cdTemplate = dailySkeleton
            .filter(ev => ev.division === divName)
            .map(ev => {
              const s = parseTimeToMinutes(ev.startTime), e = parseTimeToMinutes(ev.endTime);
              if (s == null || e == null) return null;
              const loc = ev.location || (Array.isArray(ev.reservedFields) && ev.reservedFields[0]) || null;
              return { startMin: s, endMin: e, type: window.SchedulingRules.inferTypeFromActivity(ev.event || ''), event: ev.event || '', field: loc };
            })
            .filter(Boolean);
          const _cdResult = window.SchedulingRules.checkCandidateDetailed(_cdCandidate, _cdTemplate, { mode: 'manual' });
          if (!_cdResult.allowed) {
            const _cdMsg = _cdResult.violated.map(r => '• ' + window.SchedulingRules.describeRule(r)).join('\n');
            const _cdOk = await showConfirm(`This placement may violate the following cooldown rule(s):\n\n${_cdMsg}\n\nPlace anyway?`);
            if (!_cdOk) return;
          }
        }

        // Sport player count check
        if (newEvent.type === 'sport' && newEvent.event && window.SchedulerCoreUtils?.checkPlayerCountForSport) {
          const _pcBunkMeta = window.getBunkMetaData?.() || {};
          const _pcDivObj   = (window.divisions || {})[divName] || {};
          const _pcDivBunks = _pcDivObj.bunks || [];
          const _pcDivPlayers = _pcDivBunks.reduce((s, b) => s + (_pcBunkMeta[b]?.size || 0), 0);
          const _pcSportName  = (newEvent.event || '').toLowerCase();
          const _pcConcurrent = dailySkeleton
            .filter(ev => ev.division !== divName && ev.type === 'sport' &&
              (ev.event || '').toLowerCase() === _pcSportName &&
              parseTimeToMinutes(ev.startTime) < newEndVal &&
              parseTimeToMinutes(ev.endTime)   > newStartVal)
            .reduce((s, ev) => {
              const d = (window.divisions || {})[ev.division] || {};
              return s + (d.bunks || []).reduce((ss, b) => ss + (_pcBunkMeta[b]?.size || 0), 0);
            }, 0);
          const _pcTotal = _pcDivPlayers + _pcConcurrent;
          if (_pcTotal > 0) {
            const _pcResult = window.SchedulerCoreUtils.checkPlayerCountForSport(newEvent.event, _pcTotal);
            if (!_pcResult.valid && _pcResult.reason) {
              const _pcNote = _pcConcurrent > 0
                ? `\n(Includes ${_pcConcurrent} players from other divisions at the same time)` : '';
              const _pcOk = await showConfirm(`Player count warning for "${newEvent.event}":\n${_pcResult.reason}${_pcNote}\n\nPlace anyway?`);
              if (!_pcOk) return;
            }
          }
        }

        dailySkeleton.push(newEvent);
        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
      }
    };
  });
}
// =================================================================
// RESIZE FUNCTIONALITY
// =================================================================
function addResizeListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let tooltip = document.getElementById('resize-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'resize-tooltip';
    document.body.appendChild(tooltip);
  }
  
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    const topHandle = tile.querySelector('.resize-handle-top');
    const bottomHandle = tile.querySelector('.resize-handle-bottom');
    
    [topHandle, bottomHandle].forEach(handle => {
      if (!handle) return;
      const direction = handle.classList.contains('resize-handle-top') ? 'top' : 'bottom';
      let isResizing = false, startY = 0, startTop = 0, startHeight = 0, eventId = null;
      
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        startY = e.clientY;
        startTop = parseInt(tile.style.top, 10);
        startHeight = tile.offsetHeight;
        eventId = tile.dataset.id;
        tile.classList.add('resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
      
      function onMouseMove(e) {
        if (!isResizing) return;
        const event = dailySkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const deltaY = e.clientY - startY;
        let newTop = startTop, newHeight = startHeight;
        
        if (direction === 'bottom') {
          newHeight = Math.max(SNAP_MINS * PIXELS_PER_MINUTE, startHeight + deltaY);
          newHeight = Math.round(newHeight / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
        } else {
          const maxDelta = startHeight - (SNAP_MINS * PIXELS_PER_MINUTE);
          const constrainedDelta = Math.min(deltaY, maxDelta);
          const snappedDelta = Math.round(constrainedDelta / (SNAP_MINS * PIXELS_PER_MINUTE)) * (SNAP_MINS * PIXELS_PER_MINUTE);
          newTop = startTop + snappedDelta;
          newHeight = startHeight - snappedDelta;
        }
        
        tile.style.top = newTop + 'px';
        tile.style.height = newHeight + 'px';
        
        const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
        const newEndMin = newStartMin + (newHeight / PIXELS_PER_MINUTE);
        const duration = newEndMin - newStartMin;
        const durationStr = duration < 60 ? `${duration}m` : `${Math.floor(duration/60)}h${duration%60 > 0 ? duration%60+'m' : ''}`;
        
        tooltip.innerHTML = `${minutesToTime(newStartMin)} - ${minutesToTime(newEndMin)} (${durationStr})`;
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 12) + 'px';
        tooltip.style.top = (e.clientY - 30) + 'px';
      }
      
      function onMouseUp() {
        if (!isResizing) return;
        isResizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        tile.classList.remove('resizing');
        tooltip.style.display = 'none';
        
        const event = dailySkeleton.find(ev => ev.id === eventId);
        if (!event) return;
        
        const divisions = window.divisions || {};
        const div = divisions[event.division] || {};
        const divStartMin = parseTimeToMinutes(div.startTime) || 540;
        const divEndMin = parseTimeToMinutes(div.endTime) || 960;
        
        const newTop = parseInt(tile.style.top, 10);
        const newHeightPx = parseInt(tile.style.height, 10);
        const newStartMin = earliestMin + (newTop / PIXELS_PER_MINUTE);
        const newEndMin = newStartMin + (newHeightPx / PIXELS_PER_MINUTE);
        
        event.startTime = minutesToTime(Math.max(divStartMin, Math.round(newStartMin / SNAP_MINS) * SNAP_MINS));
        event.endTime = minutesToTime(Math.min(divEndMin, Math.round(newEndMin / SNAP_MINS) * SNAP_MINS));
        
        markUnsavedChanges();
        saveDraftToLocalStorage();
        renderGrid();
      }
      
      handle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    });
  });
}

// =================================================================
// DRAG-TO-REPOSITION FUNCTIONALITY
// =================================================================
function addDragToRepositionListeners(gridEl) {
  const earliestMin = parseInt(gridEl.dataset.earliestMin, 10) || 540;
  
  let ghost = document.getElementById('drag-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'drag-ghost';
    document.body.appendChild(ghost);
  }
  
  let dragData = null;
  
  gridEl.querySelectorAll('.grid-event').forEach(tile => {
    tile.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('resize-handle')) { e.preventDefault(); return; }
      
      const eventId = tile.dataset.id;
      const event = dailySkeleton.find(ev => ev.id === eventId);
      if (!event) return;
      
      const duration = parseTimeToMinutes(event.endTime) - parseTimeToMinutes(event.startTime);
      dragData = { type: 'move', id: eventId, event, duration };
      
      e.dataTransfer.setData('text/event-move', eventId);
      e.dataTransfer.effectAllowed = 'move';
      
      ghost.innerHTML = `<strong>${event.event}</strong><br><span style="color:#64748b;">${event.startTime} - ${event.endTime}</span>`;
      ghost.style.display = 'block';
      
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);
      
      tile.style.opacity = '0.4';
    });
    
    tile.addEventListener('drag', (e) => {
      if (e.clientX === 0 && e.clientY === 0) return;
      ghost.style.left = (e.clientX + 12) + 'px';
      ghost.style.top = (e.clientY + 12) + 'px';
    });
    
    tile.addEventListener('dragend', () => {
      tile.style.opacity = '1';
      ghost.style.display = 'none';
      dragData = null;
      gridEl.querySelectorAll('.drop-preview').forEach(p => { p.style.display = 'none'; p.innerHTML = ''; });
      gridEl.querySelectorAll('.grid-cell').forEach(c => c.style.background = '');
    });
  });
  
  gridEl.querySelectorAll('.grid-cell').forEach(cell => {
    const preview = cell.querySelector('.drop-preview');
    
    cell.addEventListener('dragover', (e) => {
      const isEventMove = e.dataTransfer.types.includes('text/event-move');
      const isNewTile = e.dataTransfer.types.includes('application/json');
      if (!isEventMove && !isNewTile) return;
      
      e.preventDefault();
      e.dataTransfer.dropEffect = isEventMove ? 'move' : 'copy';
      cell.style.background = '#ecfdf5';
      
      if (isEventMove && dragData && preview) {
        const rect = cell.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const snapMin = Math.round(y / PIXELS_PER_MINUTE / SNAP_MINS) * SNAP_MINS;
        const cellStartMin = parseInt(cell.dataset.startMin, 10);
        const previewStartTime = minutesToTime(cellStartMin + snapMin);
        const previewEndTime = minutesToTime(cellStartMin + snapMin + dragData.duration);
        
        preview.style.display = 'block';
        preview.style.top = (snapMin * PIXELS_PER_MINUTE) + 'px';
        preview.style.height = (dragData.duration * PIXELS_PER_MINUTE) + 'px';
        preview.innerHTML = `<div class="preview-time-label">${previewStartTime} - ${previewEndTime}</div>`;
      }
    });
    
    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget)) {
        cell.style.background = '';
        if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
      }
    });
  });
}

// --- Helpers ---
function loadDailySkeleton() {
  const assignments = window.getSkeletonAssignments?.() || {};
  const skeletons = window.getSavedSkeletons?.() || {};
  const dateStr = window.currentScheduleDate || "";
  const [Y, M, D] = dateStr.split('-').map(Number);
  let dow = 0; if (Y && M && D) dow = new Date(Y, M - 1, D).getDay();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const today = dayNames[dow];
  
  let tmpl = assignments[today] || assignments["Default"];
  
  // Lock the UI onto the assigned template for the day
  if (!currentLoadedTemplate && tmpl) {
      currentLoadedTemplate = tmpl;
  }
  
  dailySkeleton = (tmpl && skeletons[tmpl]) ? JSON.parse(JSON.stringify(skeletons[tmpl])) : [];
}

function loadSkeletonToBuilder(name) {
  const all = window.getSavedSkeletons?.() || {};
  if (all[name]) {
    dailySkeleton = JSON.parse(JSON.stringify(all[name]));
    currentLoadedTemplate = name;
    hasUnsavedChanges = false;
    const savedOrders = (window.loadGlobalSettings?.() || {})?.app1?.skeletonColumnOrders || {};
    if (Array.isArray(savedOrders[name]) && savedOrders[name].length > 0) {
      saveColumnOrder(savedOrders[name]);
    }
  }
  renderGrid();
  renderToolbar();
  renderExpandSection();
  saveDraftToLocalStorage();
}

function parseTimeToMinutes(str) {
  if (!str) return null;
  let s = str.toLowerCase().replace(/am|pm/g, '').trim();
  let [h, m] = s.split(':').map(Number);
  if (str.toLowerCase().includes('pm') && h !== 12) h += 12;
  if (str.toLowerCase().includes('am') && h === 12) h = 0;
  return h * 60 + (m || 0);
}

function minutesToTime(min) { return window.CampUtils.minutesToTime(min); }  // → campistry_utils.js (canonical; byte-identical)

window.initMasterScheduler = init;

// Expose internals for mobile touch support + auto build integration
window.MasterSchedulerInternal = {
  get dailySkeleton() { return dailySkeleton; },
  setSkeleton: function(newSkeleton) { dailySkeleton = newSkeleton; },
  markUnsavedChanges: typeof markUnsavedChanges === 'function' ? markUnsavedChanges : function(){},
  saveDraftToLocalStorage: typeof saveDraftToLocalStorage === 'function' ? saveDraftToLocalStorage : function(){},
  renderGrid: typeof renderGrid === 'function' ? renderGrid : function(){},
  renderPalette: typeof renderPalette === 'function' ? renderPalette : function(){},
  renderToolbar: typeof renderToolbar === 'function' ? renderToolbar : function(){},
  showModal: typeof showModal === 'function' ? showModal : null,
  parseTimeToMinutes: typeof parseTimeToMinutes === 'function' ? parseTimeToMinutes : function(){ return null; },
  minutesToTime: typeof minutesToTime === 'function' ? minutesToTime : function(){ return ''; },
  // ★★★ AUTO BUILD integration ★★★
  triggerAutoBuild: function(layers) {
    if (!window.AutoBuildEngine) { console.error('AutoBuildEngine not loaded'); return null; }
    var dateStr = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    var result = window.AutoBuildEngine.build({ layers: layers, dateStr: dateStr });
    window._autoGeneratedSchedule = true;
    window._autoBuildTimelines = result.bunkTimelines;
    dailySkeleton = result.skeleton;
    if (typeof markUnsavedChanges === 'function') markUnsavedChanges();
    if (typeof saveDraftToLocalStorage === 'function') saveDraftToLocalStorage();
    if (typeof renderGrid === 'function') renderGrid();
    return result;
  },
  // Mode (read from Setup & Config, no toggle needed)
  get currentMode() { return builderMode; },
  // ★ DAW grid utility for DA to render layers independently
  renderDAWGridWith: function(el, layers, callbacks) {
    renderDAWGrid(el, layers, callbacks);
  },
  DAW_LAYER_TYPES: DAW_LAYER_TYPES,
  DAW_PIXELS_PER_MINUTE: DAW_PIXELS_PER_MINUTE,
};

  // Re-overlay period blocks whenever the bell schedule changes
  window.addEventListener('campistry-periods-changed', function() {
    const gridEl = document.getElementById('daw-grid');
    if (gridEl && typeof window.PeriodEditor?.overlayPeriodsOnDAWGrid === 'function') {
      window.PeriodEditor.overlayPeriodsOnDAWGrid(gridEl);
    }
    // Re-render panel sidebar badges if panel is open — but skip while user is typing inside it
    const panel = document.getElementById('daw-period-panel');
    if (panel && panel.style.display !== 'none' && typeof window.PeriodEditor?.renderEditor === 'function') {
      if (panel.contains(document.activeElement)) return;
      window.PeriodEditor.renderEditor(panel);
    }
  });

  // Listen for mode changes from Setup & Config
  window.addEventListener('campistry-builder-mode-changed', (e) => {
    const newMode = e.detail?.mode;
    if (newMode) {
      console.log('[MasterBuilder] Mode changed to:', newMode, '— refreshing');
      currentBuilderMode = newMode;
      builderMode = newMode;
      const manualEl = document.getElementById('ms-manual-container');
      const autoEl = document.getElementById('ms-auto-container');
      if (newMode === 'manual') {
        if (manualEl) manualEl.style.display = 'flex';
        if (autoEl) autoEl.style.display = 'none';
        // ★ Reset template lock so loadDailySkeleton re-evaluates from scratch
        currentLoadedTemplate = null;
        hasUnsavedChanges = false;
        clearDraftFromLocalStorage();
        loadDailySkeleton();
        renderGrid();
        renderToolbar();
        renderExpandSection();
      } else {
        if (manualEl) manualEl.style.display = 'none';
        if (autoEl) autoEl.style.display = 'flex';
        // ★ Clean slate for auto — reset manual state fully
        dailySkeleton = [];
        currentLoadedTemplate = null;
        hasUnsavedChanges = false;
        if (typeof renderDAW === 'function') renderDAW();
      }
    }
  });
})();
