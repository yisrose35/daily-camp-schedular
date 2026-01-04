// =================================================================
// skeleton_sandbox.js v5.1 — TILE-BASED CONFLICT DETECTOR
//
// ✔ Uses predefined TILES from palette (not skeleton)
// ✔ Smart/Split tiles checked by their component activities
// ✔ 3-way severity: Warn (Red) | Notice (Yellow) | Ignore
// ✔ Add custom tile types for pinned events
// =================================================================

(function () {
  'use strict';

  // =================================================================
  // PREDEFINED TILES (matches the palette in daily_adjustments.js)
  // =================================================================

  const PREDEFINED_TILES = [
    { name: 'Swim', type: 'swim' },
    { name: 'Lunch', type: 'lunch' },
    { name: 'Snacks', type: 'snacks' },
    { name: 'Dismissal', type: 'dismissal' },
    { name: 'League Game', type: 'league' },
    { name: 'Specialty League', type: 'specialty_league' },
    { name: 'Regroup', type: 'custom' }
  ];

  // =================================================================
  // STORAGE
  // =================================================================

  // Rules stored as: { "Swim": "warn", "Lunch": "notice", "League Game": "ignore" }
  let tileRules = {};
  let customTiles = []; // User-added custom tile names

  function loadRules() {
    try {
        const g = window.loadGlobalSettings?.() || {};
        tileRules = g.conflictRules || {};
        customTiles = g.customConflictTiles || [];
    } catch (e) {
        console.error('[ConflictDetector] Failed to load rules:', e);
    }
    return tileRules;
  }

  function saveRules() {
    if (!window.AccessControl?.canEditSetup?.()) {
        console.warn("🔐 Not authorized to save conflict rules");
        return;
    }
    window.saveGlobalSettings?.("conflictRules", tileRules);
    window.saveGlobalSettings?.("customConflictTiles", customTiles);
    window.forceSyncToCloud?.();
  }

  function getRules() {
    loadRules();
    return tileRules;
  }

  // =================================================================
  // EXTRACT ACTIVITIES FROM SMART/SPLIT TILES
  // =================================================================

  /**
   * Extract component activities from a tile event name
   * e.g., "Swim / Special Activity" → ["Swim", "Special Activity"]
   * e.g., "Art / Sports" → ["Art", "Sports"]
   * e.g., "Swim" → ["Swim"]
   */
  function extractActivities(eventName) {
    if (!eventName) return [];
    
    // Check if it's a combined tile (smart or split)
    if (eventName.includes(' / ')) {
      return eventName.split(' / ').map(s => s.trim()).filter(Boolean);
    }
    
    // Single activity
    return [eventName.trim()];
  }

  /**
   * Check if two tiles have any overlapping activities
   */
  function hasOverlappingActivity(eventA, eventB) {
    const activitiesA = extractActivities(eventA);
    const activitiesB = extractActivities(eventB);
    
    for (const actA of activitiesA) {
      for (const actB of activitiesB) {
        // Normalize for comparison
        const normA = actA.toLowerCase().trim();
        const normB = actB.toLowerCase().trim();
        
        if (normA === normB) {
          return actA; // Return the matching activity name
        }
        
        // Also check partial matches for common variations
        // e.g., "Swim" should match "Swim" in "Swim / Special"
        if (normA.includes(normB) || normB.includes(normA)) {
          return actA.length <= actB.length ? actA : actB;
        }
      }
    }
    
    return null; // No overlap
  }

  /**
   * Get the severity for an activity (checks all component activities)
   */
  function getActivitySeverity(eventName) {
    const activities = extractActivities(eventName);
    
    let highestSeverity = null;
    let matchedActivity = null;
    
    for (const activity of activities) {
      const severity = tileRules[activity];
      if (severity === 'warn') {
        return { severity: 'warn', activity }; // Warn is highest, return immediately
      }
      if (severity === 'notice' && highestSeverity !== 'warn') {
        highestSeverity = 'notice';
        matchedActivity = activity;
      }
    }
    
    return highestSeverity ? { severity: highestSeverity, activity: matchedActivity } : null;
  }

  // =================================================================
  // CONFLICT DETECTION ENGINE
  // =================================================================

  function parseTime(str) {
    if (!str) return null;
    let s = str.toLowerCase().trim();
    let mer = null;
    if (s.endsWith('am') || s.endsWith('pm')) {
      mer = s.slice(-2);
      s = s.slice(0, -2).trim();
    }
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    let h = +m[1], min = +m[2];
    if (mer === 'pm' && h !== 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (!mer && h <= 7) h += 12;
    return h * 60 + min;
  }

  function timesOverlap(a, b) {
    const s1 = parseTime(a.startTime), e1 = parseTime(a.endTime);
    const s2 = parseTime(b.startTime), e2 = parseTime(b.endTime);
    if (s1 === null || e1 === null || s2 === null || e2 === null) return false;
    return s1 < e2 && e1 > s2;
  }

  function detectConflicts(skeleton) {
    loadRules();
    if (!skeleton?.length) return [];
    
    const conflicts = [];
    const seen = new Set();

    for (let i = 0; i < skeleton.length; i++) {
      for (let j = i + 1; j < skeleton.length; j++) {
        const a = skeleton[i], b = skeleton[j];
        
        // Must be different divisions
        if (a.division === b.division) continue;
        
        // Must overlap in time
        if (!timesOverlap(a, b)) continue;
        
        // Check if any activities overlap between the two tiles
        const overlappingActivity = hasOverlappingActivity(a.event, b.event);
        
        if (!overlappingActivity) continue;
        
        // Check if this activity has a rule
        const severity = tileRules[overlappingActivity];
        if (!severity || severity === 'ignore') continue;
        
        // Avoid duplicate conflict entries
        const key = [a.id, b.id].sort().join('|') + '_' + overlappingActivity;
        if (seen.has(key)) continue;
        seen.add(key);
        
        conflicts.push({
          type: severity, // 'warn' or 'notice'
          resource: overlappingActivity,
          event1: a,
          event2: b
        });
      }
    }
    
    // Also check for reserved field conflicts
    for (let i = 0; i < skeleton.length; i++) {
      for (let j = i + 1; j < skeleton.length; j++) {
        const a = skeleton[i], b = skeleton[j];
        
        if (a.division === b.division) continue;
        if (!timesOverlap(a, b)) continue;
        
        // Check reserved fields overlap
        const aFields = a.reservedFields || [];
        const bFields = b.reservedFields || [];
        const shared = aFields.filter(f => bFields.includes(f));
        
        if (shared.length > 0) {
          const key = `field_${[a.id, b.id].sort().join('|')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          
          conflicts.push({
            type: 'warn', // Field conflicts are always warnings
            resource: `Field: ${shared[0]}`,
            event1: a,
            event2: b
          });
        }
      }
    }
    
    return conflicts;
  }

  // =================================================================
  // GET ALL TILES FOR THE MODAL
  // =================================================================

  function getAllTiles() {
    loadRules();
    
    // Start with predefined tiles
    const tiles = PREDEFINED_TILES.map(t => ({
      name: t.name,
      type: t.type,
      isPredefined: true
    }));
    
    // Add custom tiles
    customTiles.forEach(name => {
      if (!tiles.find(t => t.name === name)) {
        tiles.push({
          name: name,
          type: 'custom',
          isPredefined: false
        });
      }
    });
    
    return tiles;
  }

  // =================================================================
  // MODAL UI
  // =================================================================

  function showRulesModal(onClose, currentSkeleton) {
    loadRules();
    
    const tiles = getAllTiles();
    
    // Inject styles
    injectStyles();
    
    const overlay = document.createElement('div');
    overlay.className = 'cd-overlay';

    const modal = document.createElement('div');
    modal.className = 'cd-modal';

    modal.innerHTML = `
      <div class="cd-header">
        <div>
          <h2 class="cd-title">Conflict Detection</h2>
          <p class="cd-subtitle">Set how each tile type should be flagged when it appears in multiple divisions at the same time. Smart and Split tiles are checked by their component activities.</p>
        </div>
        <button class="cd-close-btn">×</button>
      </div>

      <div class="cd-body">
        <div class="cd-legend">
          <span class="cd-legend-item"><span class="cd-dot cd-dot-warn"></span> Warn (Red)</span>
          <span class="cd-legend-item"><span class="cd-dot cd-dot-notice"></span> Notice (Yellow)</span>
          <span class="cd-legend-item"><span class="cd-dot cd-dot-ignore"></span> Ignore</span>
        </div>
        
        <div class="cd-tiles-list" id="cd-tiles-list">
          <!-- Tiles will be rendered here -->
        </div>
        
        <button id="cd-add-custom" class="cd-add-btn">
          <span>+</span> Add Custom Activity
        </button>
      </div>

      <div class="cd-footer">
        <button class="cd-btn-secondary" id="cd-reset-btn">Reset to Defaults</button>
        <button class="cd-btn-primary" id="cd-apply-btn">Apply & Scan</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listContainer = modal.querySelector('#cd-tiles-list');

    // Close handler
    const close = (shouldApply = false) => {
      overlay.classList.add('fade-out');
      setTimeout(() => {
        overlay.remove();
        if (shouldApply && typeof onClose === 'function') {
          onClose();
        }
      }, 200);
    };

    modal.querySelector('.cd-close-btn').onclick = () => close(false);
    
    modal.querySelector('#cd-apply-btn').onclick = () => {
      saveRules();
      close(true);
    };
    
    modal.querySelector('#cd-reset-btn').onclick = () => {
      if (confirm('Reset all rules to defaults?')) {
        // Set sensible defaults
        tileRules = {
          'Swim': 'warn',
          'Lunch': 'notice',
          'Snacks': 'notice',
          'Dismissal': 'notice',
          'League Game': 'notice',
          'Specialty League': 'notice',
          'Regroup': 'ignore'
        };
        renderTiles();
      }
    };

    modal.querySelector('#cd-add-custom').onclick = () => {
      const name = prompt("Enter activity name (e.g., 'Pool', 'Art', 'Music'):", "");
      if (name && name.trim()) {
        const trimmed = name.trim();
        if (!tiles.find(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
          customTiles.push(trimmed);
          tileRules[trimmed] = 'notice';
          tiles.push({ name: trimmed, type: 'custom', isPredefined: false });
          renderTiles();
        } else {
          alert('This activity already exists.');
        }
      }
    };

    function renderTiles() {
      listContainer.innerHTML = '';
      
      if (tiles.length === 0) {
        listContainer.innerHTML = `
          <div class="cd-empty">
            No tiles configured. Add a custom activity.
          </div>
        `;
        return;
      }

      tiles.forEach(tile => {
        // Get current severity or default
        let severity = tileRules[tile.name];
        if (!severity) {
          // Set defaults based on tile type
          const lower = tile.name.toLowerCase();
          if (lower.includes('swim') || lower.includes('pool')) {
            severity = 'warn';
          } else if (lower.includes('league') || lower.includes('lunch') || lower.includes('dismissal') || lower.includes('snack')) {
            severity = 'notice';
          } else {
            severity = 'ignore';
          }
          tileRules[tile.name] = severity;
        }

        const row = document.createElement('div');
        row.className = 'cd-tile-row';
        row.innerHTML = `
          <div class="cd-tile-info">
            <span class="cd-tile-name">${tile.name}</span>
            ${tile.isPredefined ? '' : '<span class="cd-tile-count cd-custom">custom</span>'}
          </div>
          <div class="cd-severity-slider">
            <button class="cd-sev-btn ${severity === 'warn' ? 'active' : ''}" data-sev="warn" title="Warn (Red)">
              <span class="cd-sev-dot cd-dot-warn"></span>
              Warn
            </button>
            <button class="cd-sev-btn ${severity === 'notice' ? 'active' : ''}" data-sev="notice" title="Notice (Yellow)">
              <span class="cd-sev-dot cd-dot-notice"></span>
              Notice
            </button>
            <button class="cd-sev-btn ${severity === 'ignore' ? 'active' : ''}" data-sev="ignore" title="Ignore">
              <span class="cd-sev-dot cd-dot-ignore"></span>
              Ignore
            </button>
          </div>
          ${!tile.isPredefined ? `<button class="cd-remove-btn" title="Remove">×</button>` : ''}
        `;

        // Wire up severity buttons
        row.querySelectorAll('.cd-sev-btn').forEach(btn => {
          btn.onclick = () => {
            tileRules[tile.name] = btn.dataset.sev;
            row.querySelectorAll('.cd-sev-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          };
        });

        // Wire up remove button (only for custom tiles)
        const removeBtn = row.querySelector('.cd-remove-btn');
        if (removeBtn) {
          removeBtn.onclick = () => {
            delete tileRules[tile.name];
            const idx = customTiles.indexOf(tile.name);
            if (idx >= 0) customTiles.splice(idx, 1);
            const tileIdx = tiles.findIndex(t => t.name === tile.name);
            if (tileIdx >= 0) tiles.splice(tileIdx, 1);
            renderTiles();
          };
        }

        listContainer.appendChild(row);
      });
    }

    renderTiles();
  }

  // =================================================================
  // CSS INJECTION
  // =================================================================

  function injectStyles() {
    if (document.getElementById('cd-styles')) return;

    const css = `
      /* OVERLAY */
      .cd-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5);
        backdrop-filter: blur(4px); z-index: 9999;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; animation: cdFadeIn 0.2s forwards;
      }
      .cd-overlay.fade-out { animation: cdFadeOut 0.2s forwards; }

      /* MODAL */
      .cd-modal {
        background: #ffffff; width: 550px; max-width: 95%; max-height: 85vh;
        border-radius: 16px;
        box-shadow: 0 25px 50px rgba(0,0,0,0.2);
        display: flex; flex-direction: column; overflow: hidden;
        animation: cdSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }

      /* HEADER */
      .cd-header {
        padding: 20px 24px; border-bottom: 1px solid #e5e7eb;
        display: flex; justify-content: space-between; align-items: flex-start;
        background: #fafafa;
      }
      .cd-title { margin: 0; font-size: 1.2rem; font-weight: 700; color: #111827; }
      .cd-subtitle { margin: 6px 0 0; font-size: 0.85rem; color: #6b7280; line-height: 1.4; }
      .cd-close-btn {
        background: transparent; border: none; font-size: 28px; color: #9ca3af;
        cursor: pointer; padding: 0; line-height: 1; transition: color 0.2s;
        margin-top: -4px;
      }
      .cd-close-btn:hover { color: #111827; }

      /* BODY */
      .cd-body { 
        padding: 16px 24px; flex: 1; overflow-y: auto; 
        background: #fff;
      }

      /* LEGEND */
      .cd-legend {
        display: flex; gap: 16px; margin-bottom: 16px; padding-bottom: 12px;
        border-bottom: 1px solid #f3f4f6;
      }
      .cd-legend-item {
        display: flex; align-items: center; gap: 6px;
        font-size: 0.8rem; color: #6b7280;
      }
      .cd-dot {
        width: 10px; height: 10px; border-radius: 50%;
      }
      .cd-dot-warn { background: #dc2626; }
      .cd-dot-notice { background: #f59e0b; }
      .cd-dot-ignore { background: #d1d5db; }

      /* TILES LIST */
      .cd-tiles-list {
        display: flex; flex-direction: column; gap: 8px;
      }

      /* TILE ROW */
      .cd-tile-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 14px; background: #f9fafb; border-radius: 10px;
        border: 1px solid #e5e7eb; transition: all 0.15s;
      }
      .cd-tile-row:hover { background: #f3f4f6; border-color: #d1d5db; }

      .cd-tile-info {
        flex: 1; display: flex; align-items: center; gap: 8px;
      }
      .cd-tile-name {
        font-weight: 600; color: #1f2937; font-size: 0.95rem;
      }
      .cd-tile-count {
        font-size: 0.75rem; color: #9ca3af; background: #e5e7eb;
        padding: 2px 6px; border-radius: 4px;
      }
      .cd-tile-count.cd-custom {
        background: #dbeafe; color: #2563eb;
      }

      /* SEVERITY SLIDER */
      .cd-severity-slider {
        display: flex; background: #e5e7eb; border-radius: 8px; padding: 3px;
      }
      .cd-sev-btn {
        display: flex; align-items: center; gap: 4px;
        padding: 6px 10px; border: none; background: transparent;
        font-size: 0.75rem; font-weight: 600; color: #6b7280;
        border-radius: 6px; cursor: pointer; transition: all 0.15s;
        white-space: nowrap;
      }
      .cd-sev-btn:hover { color: #374151; }
      .cd-sev-btn.active {
        background: #fff; color: #111827;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      }
      .cd-sev-btn.active[data-sev="warn"] { color: #dc2626; }
      .cd-sev-btn.active[data-sev="notice"] { color: #d97706; }
      .cd-sev-btn.active[data-sev="ignore"] { color: #6b7280; }

      .cd-sev-dot {
        width: 8px; height: 8px; border-radius: 50%;
      }

      /* REMOVE BUTTON */
      .cd-remove-btn {
        width: 24px; height: 24px; border-radius: 50%; border: none;
        background: transparent; color: #d1d5db; font-size: 18px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: all 0.15s;
      }
      .cd-remove-btn:hover { background: #fee2e2; color: #dc2626; }

      /* ADD BUTTON */
      .cd-add-btn {
        width: 100%; margin-top: 12px; padding: 12px;
        border: 2px dashed #d1d5db; border-radius: 10px;
        background: transparent; color: #6b7280; font-weight: 600;
        font-size: 0.9rem; cursor: pointer; transition: all 0.15s;
        display: flex; align-items: center; justify-content: center; gap: 6px;
      }
      .cd-add-btn:hover { border-color: #2563eb; color: #2563eb; background: #eff6ff; }

      /* EMPTY STATE */
      .cd-empty {
        padding: 40px 20px; text-align: center; color: #9ca3af;
        font-size: 0.9rem; line-height: 1.5;
      }

      /* FOOTER */
      .cd-footer {
        padding: 16px 24px; border-top: 1px solid #e5e7eb;
        display: flex; justify-content: space-between; gap: 12px;
        background: #fafafa;
      }
      .cd-btn-secondary {
        padding: 10px 16px; border-radius: 8px; font-weight: 600;
        font-size: 0.9rem; cursor: pointer; transition: all 0.15s;
        background: #fff; border: 1px solid #d1d5db; color: #374151;
      }
      .cd-btn-secondary:hover { background: #f3f4f6; border-color: #9ca3af; }
      
      .cd-btn-primary {
        padding: 10px 20px; border-radius: 8px; font-weight: 600;
        font-size: 0.9rem; cursor: pointer; transition: all 0.15s;
        background: #111827; border: none; color: #fff;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      }
      .cd-btn-primary:hover { background: #000; transform: translateY(-1px); }

      /* ANIMATIONS */
      @keyframes cdFadeIn { to { opacity: 1; } }
      @keyframes cdFadeOut { to { opacity: 0; } }
      @keyframes cdSlideUp { 
        from { transform: translateY(20px); opacity: 0; } 
        to { transform: translateY(0); opacity: 1; } 
      }
    `;

    const s = document.createElement('style');
    s.id = 'cd-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // =================================================================
  // EXPORT
  // =================================================================

  window.SkeletonSandbox = {
    detectConflicts,
    showRulesModal,
    loadRules,
    saveRules,
    getRules,
    getAllTiles,
    extractActivities,
    hasOverlappingActivity
  };

})();
