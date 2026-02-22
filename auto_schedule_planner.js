// =================================================================
// auto_schedule_planner.js v2.0 — DAW Layer Planner
// =================================================================
// Renders the DAW-style timeline for placing layers.
// Used in BOTH Master Schedule Builder and Daily Adjustments.
//
// Features:
//   - Same tile palette as manual mode (minus Smart Tile)
//   - Horizontal timeline per grade with draggable/resizable bands
//   - Click popover: time, period duration, quantity, pin toggle
//   - Template save/load/assign
//   - Generates skeleton via AutoSkeletonBuilder
// =================================================================

(function() {
  'use strict';

  // ---------------------------------------------------------------
  // TILE DEFINITIONS (same as manual mode, minus Smart Tile)
  // ---------------------------------------------------------------
  const TILES = [
    // Slots
    { type: 'activity',         name: 'Activity',          style: 'background:#bbf7d0;color:#14532d;',                    cat: 'Slots' },
    { type: 'sports',           name: 'Sports',            style: 'background:#86efac;color:#14532d;',                    cat: 'Slots' },
    { type: 'special',          name: 'Special Activity',  style: 'background:#c4b5fd;color:#3b1f6b;',                    cat: 'Slots' },
    // Advanced
    { type: 'split',            name: 'Split Activity',    style: 'background:#fdba74;color:#7c2d12;',                    cat: 'Advanced' },
    { type: 'elective',         name: 'Elective',          style: 'background:#f0abfc;color:#701a75;',                    cat: 'Advanced' },
    // Leagues
    { type: 'league',           name: 'League Game',       style: 'background:#a5b4fc;color:#312e81;',                    cat: 'Leagues' },
    { type: 'specialty_league', name: 'Specialty League',   style: 'background:#d8b4fe;color:#581c87;',                    cat: 'Leagues' },
    // Fixed
    { type: 'swim',             name: 'Swim',              style: 'background:#67e8f9;color:#155e75;',                    cat: 'Fixed' },
    { type: 'lunch',            name: 'Lunch',             style: 'background:#fca5a5;color:#7f1d1d;',                    cat: 'Fixed' },
    { type: 'snacks',           name: 'Snacks',            style: 'background:#fde047;color:#713f12;',                    cat: 'Fixed' },
    { type: 'dismissal',        name: 'Dismissal',         style: 'background:#f87171;color:white;',                      cat: 'Fixed' },
    { type: 'custom',           name: 'Custom Pinned',     style: 'background:#d1d5db;color:#374151;',                    cat: 'Fixed' },
  ];

  const FIXED_TYPES = ['swim', 'lunch', 'snacks', 'dismissal', 'custom'];
  const CATEGORIES = ['Slots', 'Advanced', 'Leagues', 'Fixed'];

  // ---------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------
  let rootEl = null;
  let layers = [];        // [{ id, type, grade, startMin, endMin, periodMin, operator, quantity, pinExact, event }]
  let currentTemplate = '';
  let hasChanges = false;

  // ---------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------
  function toTime(min) {
    if (min == null) return '';
    const h = Math.floor(min / 60), m = min % 60;
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ampm;
  }

  function toMin(str) {
    if (typeof str === 'number') return str;
    if (!str) return null;
    const match = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (match[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (match[3].toLowerCase() === 'am' && h === 12) h = 0;
    return h * 60 + m;
  }

  function uid() { return 'lyr_' + Math.random().toString(36).slice(2, 9); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function getGrades() {
    const divs = window.divisions || window.loadGlobalSettings?.()?.app1?.divisions || {};
    return Object.entries(divs)
      .filter(([, d]) => d.parentDivision || d.startTime) // only real scheduling grades
      .filter(([, d]) => d.startTime) // must have own start time
      .map(([name, d]) => ({
        name,
        startMin: toMin(d.startTime) || 540,
        endMin: toMin(d.endTime) || 960,
        bunks: d.bunks || []
      }))
      .sort((a, b) => {
        const na = parseInt(a.name), nb = parseInt(b.name);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.name.localeCompare(b.name);
      });
  }

  // ---------------------------------------------------------------
  // SAVE / LOAD TEMPLATES
  // ---------------------------------------------------------------
  function saveTemplate(name) {
    if (!name) return;
    const g = window.loadGlobalSettings?.() || {};
    g.app1 = g.app1 || {};
    g.app1.autoLayerTemplates = g.app1.autoLayerTemplates || {};
    g.app1.autoLayerTemplates[name] = JSON.parse(JSON.stringify(layers));
    window.saveGlobalSettings?.('app1', g.app1);
    currentTemplate = name;
    hasChanges = false;
    render();
  }

  function loadTemplate(name) {
    const g = window.loadGlobalSettings?.() || {};
    const tmpl = g.app1?.autoLayerTemplates?.[name];
    if (!tmpl) return;
    layers = JSON.parse(JSON.stringify(tmpl));
    currentTemplate = name;
    hasChanges = false;
    render();
  }

  function deleteTemplate(name) {
    if (!name) return;
    const g = window.loadGlobalSettings?.() || {};
    if (g.app1?.autoLayerTemplates?.[name]) {
      delete g.app1.autoLayerTemplates[name];
      window.saveGlobalSettings?.('app1', g.app1);
    }
    if (currentTemplate === name) { currentTemplate = ''; layers = []; }
    render();
  }

  function getTemplateNames() {
    const g = window.loadGlobalSettings?.() || {};
    return Object.keys(g.app1?.autoLayerTemplates || {});
  }

  function saveAssignments(assignments) {
    const g = window.loadGlobalSettings?.() || {};
    g.app1 = g.app1 || {};
    g.app1.layerAssignments = assignments;
    window.saveGlobalSettings?.('app1', g.app1);
  }

  function getAssignments() {
    const g = window.loadGlobalSettings?.() || {};
    return g.app1?.layerAssignments || {};
  }

  // ---------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------
  function render() {
    if (!rootEl) return;
    const grades = getGrades();
    if (grades.length === 0) {
      rootEl.innerHTML = '<div style="padding:40px;text-align:center;color:#6b7280;">No grades configured with start/end times. Set these in Setup & Config.</div>';
      return;
    }

    rootEl.innerHTML = '';

    // Toolbar
    rootEl.appendChild(renderToolbar());

    // Palette + Timeline
    const main = document.createElement('div');
    main.className = 'al-main';
    main.style.cssText = 'display:flex; gap:16px; margin-top:12px;';

    main.appendChild(renderPalette());
    main.appendChild(renderTimeline(grades));

    rootEl.appendChild(main);

    // Day Assignments (collapsible)
    rootEl.appendChild(renderDayAssignments());
  }

  // ---------------------------------------------------------------
  // TOOLBAR
  // ---------------------------------------------------------------
  function renderToolbar() {
    const bar = document.createElement('div');
    bar.className = 'al-toolbar';
    bar.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0;';

    // Template name
    const label = document.createElement('span');
    label.style.cssText = 'font-weight:600; color:#374151; font-size:0.9rem;';
    label.textContent = currentTemplate ? `Template: ${currentTemplate}${hasChanges ? ' •' : ''}` : 'No template loaded';
    bar.appendChild(label);

    // Load dropdown
    const names = getTemplateNames();
    if (names.length > 0) {
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:4px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;';
      sel.innerHTML = '<option value="">Load...</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      sel.onchange = () => { if (sel.value) loadTemplate(sel.value); };
      bar.appendChild(sel);
    }

    // Buttons
    const btns = [
      { text: 'Save', fn: () => { if (currentTemplate) saveTemplate(currentTemplate); else promptSaveAs(); } },
      { text: 'Save As', fn: promptSaveAs },
      { text: 'Clear All', fn: () => { layers = []; hasChanges = true; render(); } },
      { text: 'Preview', fn: previewSkeleton },
    ];
    btns.forEach(({ text, fn }) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.className = 'al-toolbar-btn';
      b.style.cssText = 'padding:5px 12px; border:1px solid #d1d5db; border-radius:6px; background:white; cursor:pointer; font-size:0.85rem; font-weight:500;';
      b.onclick = fn;
      bar.appendChild(b);
    });

    return bar;
  }

  function promptSaveAs() {
    const name = prompt('Template name:', currentTemplate || '');
    if (name?.trim()) saveTemplate(name.trim());
  }

  // ---------------------------------------------------------------
  // PALETTE (left sidebar)
  // ---------------------------------------------------------------
  function renderPalette() {
    const pal = document.createElement('div');
    pal.className = 'al-palette';
    pal.style.cssText = 'width:160px; flex-shrink:0; display:flex; flex-direction:column; gap:4px;';

    CATEGORIES.forEach(cat => {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:0.7rem; font-weight:700; color:#9ca3af; text-transform:uppercase; letter-spacing:0.05em; margin-top:8px;';
      header.textContent = cat;
      pal.appendChild(header);

      TILES.filter(t => t.cat === cat).forEach(tile => {
        const el = document.createElement('div');
        el.className = 'al-tile';
        el.setAttribute('style', tile.style + 'padding:6px 10px; border-radius:6px; font-size:0.8rem; font-weight:600; cursor:grab; user-select:none; margin-bottom:2px;');
        el.textContent = tile.name;
        el.draggable = true;
        el.addEventListener('dragstart', e => {
          e.dataTransfer.setData('application/json', JSON.stringify(tile));
        });
        pal.appendChild(el);
      });
    });

    return pal;
  }

  // ---------------------------------------------------------------
  // TIMELINE (main area)
  // ---------------------------------------------------------------
  function renderTimeline(grades) {
    const container = document.createElement('div');
    container.className = 'al-timeline';
    container.style.cssText = 'flex:1; overflow-x:auto;';

    grades.forEach(grade => {
      container.appendChild(renderGradeRow(grade));
    });

    return container;
  }

  function renderGradeRow(grade) {
    const PX_PER_MIN = 2; // pixels per minute
    const totalMin = grade.endMin - grade.startMin;
    const totalPx = totalMin * PX_PER_MIN;

    const row = document.createElement('div');
    row.className = 'al-grade-row';
    row.style.cssText = `position:relative; margin-bottom:16px; border:1px solid #e5e7eb; border-radius:8px; background:white; overflow:hidden;`;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px; background:#f8fafc; border-bottom:1px solid #e5e7eb; font-weight:600; font-size:0.9rem; color:#374151; display:flex; justify-content:space-between;';
    header.innerHTML = `<span>${esc(grade.name)}</span><span style="font-weight:400; color:#9ca3af; font-size:0.8rem;">${toTime(grade.startMin)} – ${toTime(grade.endMin)}</span>`;
    row.appendChild(header);

    // Timeline area
    const timeline = document.createElement('div');
    timeline.className = 'al-grade-timeline';
    timeline.style.cssText = `position:relative; height:auto; min-height:60px; width:${totalPx}px; padding:8px 0;`;

    // Time markers
    for (let t = grade.startMin; t <= grade.endMin; t += 30) {
      const x = (t - grade.startMin) * PX_PER_MIN;
      const marker = document.createElement('div');
      marker.style.cssText = `position:absolute; left:${x}px; top:0; bottom:0; border-left:1px solid ${t % 60 === 0 ? '#d1d5db' : '#f3f4f6'}; z-index:0;`;
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute; top:-2px; left:2px; font-size:0.6rem; color:#9ca3af; white-space:nowrap;';
      lbl.textContent = toTime(t);
      marker.appendChild(lbl);
      timeline.appendChild(marker);
    }

    // Existing layer bands
    const gradeLayers = layers.filter(l => l.grade === grade.name);
    gradeLayers.forEach(layer => {
      timeline.appendChild(renderBand(layer, grade, PX_PER_MIN));
    });

    // Drop zone
    timeline.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    timeline.addEventListener('drop', e => {
      e.preventDefault();
      try {
        const tile = JSON.parse(e.dataTransfer.getData('application/json'));
        const rect = timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const dropMin = Math.round(x / PX_PER_MIN / 5) * 5 + grade.startMin;

        const isPinned = FIXED_TYPES.includes(tile.type);
        const defaultDur = isPinned ? 30 : (grade.endMin - grade.startMin);

        const newLayer = {
          id: uid(),
          type: tile.type,
          event: tile.name,
          grade: grade.name,
          startMin: isPinned ? dropMin : grade.startMin,
          endMin: isPinned ? (dropMin + defaultDur) : grade.endMin,
          periodMin: 40,
          operator: 'gte',
          quantity: 1,
          pinExact: isPinned
        };

        layers.push(newLayer);
        hasChanges = true;
        render();
      } catch (err) {
        console.error('[AutoPlanner] Drop error:', err);
      }
    });

    row.appendChild(timeline);
    return row;
  }

  // ---------------------------------------------------------------
  // BAND (layer visual on timeline)
  // ---------------------------------------------------------------
  function renderBand(layer, grade, pxPerMin) {
    const tile = TILES.find(t => t.type === layer.type) || TILES[0];
    const left = (layer.startMin - grade.startMin) * pxPerMin;
    const width = (layer.endMin - layer.startMin) * pxPerMin;

    const band = document.createElement('div');
    band.className = 'al-band' + (layer.pinExact ? ' al-band-pinned' : '');
    band.style.cssText = `
      position:relative; display:inline-block; vertical-align:top;
      margin:4px ${left}px 4px 0; margin-left:${left}px;
      width:${width}px; height:28px; border-radius:4px;
      ${tile.style}
      border:${layer.pinExact ? '3px solid rgba(0,0,0,0.3)' : '2px dashed rgba(0,0,0,0.2)'};
      font-size:0.7rem; font-weight:600; line-height:28px;
      padding:0 6px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
      cursor:pointer; z-index:1;
    `;

    // Label
    const qtyLabel = layer.pinExact ? '' : ` ${layer.operator === 'gte' ? '≥' : layer.operator === 'lte' ? '≤' : '='}${layer.quantity}×${layer.periodMin}m`;
    band.textContent = `${layer.event || tile.name}${qtyLabel}`;
    band.title = `${layer.event || tile.name} ${toTime(layer.startMin)}-${toTime(layer.endMin)}${qtyLabel}`;

    // Click → popover
    band.onclick = (e) => {
      e.stopPropagation();
      showPopover(layer, band);
    };

    return band;
  }

  // ---------------------------------------------------------------
  // POPOVER (edit layer settings)
  // ---------------------------------------------------------------
  function showPopover(layer, anchorEl) {
    // Remove any existing popover
    document.querySelector('.al-popover')?.remove();

    const pop = document.createElement('div');
    pop.className = 'al-popover';
    pop.style.cssText = `
      position:fixed; z-index:10000; background:white; border:1px solid #d1d5db;
      border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.15); padding:16px;
      width:280px; font-size:0.85rem;
    `;

    const tile = TILES.find(t => t.type === layer.type) || {};

    pop.innerHTML = `
      <div style="font-weight:700; font-size:1rem; margin-bottom:12px; color:#1f2937;">${esc(tile.name || layer.type)}</div>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <label style="flex:1;">Start<br><input type="text" id="al-pop-start" value="${toTime(layer.startMin)}" style="width:100%; padding:4px 8px; border:1px solid #d1d5db; border-radius:6px;"></label>
        <label style="flex:1;">End<br><input type="text" id="al-pop-end" value="${toTime(layer.endMin)}" style="width:100%; padding:4px 8px; border:1px solid #d1d5db; border-radius:6px;"></label>
      </div>
      <div id="al-pop-period-row" style="display:${layer.pinExact ? 'none' : 'flex'}; gap:8px; margin-bottom:10px;">
        <label style="flex:1;">Period<br><input type="number" id="al-pop-period" value="${layer.periodMin || 40}" min="5" max="120" step="5" style="width:100%; padding:4px 8px; border:1px solid #d1d5db; border-radius:6px;"> min</label>
      </div>
      <div id="al-pop-qty-row" style="display:${layer.pinExact ? 'none' : 'flex'}; gap:8px; align-items:end; margin-bottom:10px;">
        <label style="flex:1;">Quantity<br>
          <div style="display:flex; gap:4px;">
            <select id="al-pop-op" style="padding:4px; border:1px solid #d1d5db; border-radius:6px;">
              <option value="gte" ${layer.operator === 'gte' ? 'selected' : ''}>≥</option>
              <option value="lte" ${layer.operator === 'lte' ? 'selected' : ''}>≤</option>
              <option value="eq" ${layer.operator === 'eq' ? 'selected' : ''}>=</option>
            </select>
            <input type="number" id="al-pop-qty" value="${layer.quantity || 1}" min="1" max="20" style="width:60px; padding:4px 8px; border:1px solid #d1d5db; border-radius:6px;">
          </div>
        </label>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-bottom:14px; cursor:pointer;">
        <input type="checkbox" id="al-pop-pin" ${layer.pinExact ? 'checked' : ''}>
        <span>Pin to exact time</span>
      </label>
      <div style="display:flex; justify-content:space-between;">
        <button id="al-pop-delete" style="padding:5px 12px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:0.85rem;">Delete</button>
        <button id="al-pop-done" style="padding:5px 16px; background:#147D91; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem; font-weight:600;">Done</button>
      </div>
    `;

    document.body.appendChild(pop);

    // Position near anchor
    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';

    // Pin toggle: show/hide period+qty rows
    pop.querySelector('#al-pop-pin').onchange = function() {
      const hidden = this.checked ? 'none' : 'flex';
      pop.querySelector('#al-pop-period-row').style.display = hidden;
      pop.querySelector('#al-pop-qty-row').style.display = hidden;
    };

    // Done
    pop.querySelector('#al-pop-done').onclick = () => {
      const startMin = toMin(pop.querySelector('#al-pop-start').value);
      const endMin = toMin(pop.querySelector('#al-pop-end').value);
      if (startMin != null) layer.startMin = startMin;
      if (endMin != null) layer.endMin = endMin;
      layer.periodMin = parseInt(pop.querySelector('#al-pop-period').value) || 40;
      layer.operator = pop.querySelector('#al-pop-op').value;
      layer.quantity = parseInt(pop.querySelector('#al-pop-qty').value) || 1;
      layer.pinExact = pop.querySelector('#al-pop-pin').checked;
      hasChanges = true;
      pop.remove();
      render();
    };

    // Delete
    pop.querySelector('#al-pop-delete').onclick = () => {
      layers = layers.filter(l => l.id !== layer.id);
      hasChanges = true;
      pop.remove();
      render();
    };

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function closer(e) {
        if (!pop.contains(e.target) && e.target !== anchorEl) {
          pop.remove();
          document.removeEventListener('click', closer);
        }
      });
    }, 50);
  }

  // ---------------------------------------------------------------
  // DAY ASSIGNMENTS
  // ---------------------------------------------------------------
  function renderDayAssignments() {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:16px; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;';

    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px; background:#f8fafc; border-bottom:1px solid #e5e7eb; cursor:pointer; font-weight:600; font-size:0.9rem; color:#374151; display:flex; justify-content:space-between;';
    header.textContent = 'Day Assignments';
    const caret = document.createElement('span');
    caret.textContent = '▼';
    caret.style.cssText = 'transition:transform 0.2s;';
    header.appendChild(caret);

    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 14px; display:none;';

    header.onclick = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      caret.style.transform = open ? '' : 'rotate(180deg)';
    };

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Default'];
    const assignments = getAssignments();
    const names = getTemplateNames();

    days.forEach(day => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:6px;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'width:80px; font-size:0.85rem; color:#4b5563;';
      lbl.textContent = day;
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1; padding:4px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.85rem;';
      sel.innerHTML = '<option value="">— None —</option>' + names.map(n => `<option value="${esc(n)}" ${assignments[day] === n ? 'selected' : ''}>${esc(n)}</option>`).join('');
      sel.onchange = () => {
        const a = getAssignments();
        if (sel.value) a[day] = sel.value;
        else delete a[day];
        saveAssignments(a);
      };
      row.appendChild(lbl);
      row.appendChild(sel);
      body.appendChild(row);
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  // ---------------------------------------------------------------
  // PREVIEW / GENERATE
  // ---------------------------------------------------------------
  function previewSkeleton() {
    if (layers.length === 0) {
      alert('No layers to preview. Drag tiles from the palette onto the timeline.');
      return;
    }

    const result = window.AutoSkeletonBuilder?.buildAll(layers);
    if (!result) {
      alert('AutoSkeletonBuilder not loaded.');
      return;
    }

    console.log('[AutoPlanner] Preview result:', result);

    const msg = result.skeleton.length + ' skeleton items generated.\n' +
      (result.warnings.length > 0 ? 'Warnings:\n' + result.warnings.join('\n') : 'No warnings.') +
      '\n\nCheck console for details.';
    alert(msg);
  }

  /**
   * Generate schedule from current layers.
   * Called from Daily Adjustments "Generate" button.
   */
  function generateFromLayers(dateKey) {
    if (!window.AutoSkeletonBuilder) {
      console.error('[AutoPlanner] AutoSkeletonBuilder not loaded');
      return null;
    }

    const result = window.AutoSkeletonBuilder.buildAll(layers);
    console.log('[AutoPlanner] Generated skeleton:', result.skeleton.length, 'items');

    return result.skeleton;
  }

  // ---------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------
  function init(containerId) {
    rootEl = document.getElementById(containerId);
    if (!rootEl) {
      console.warn('[AutoPlanner] Container not found:', containerId);
      return;
    }
    render();
  }

  /**
   * Render for a specific day in Daily Adjustments.
   * Loads the template assigned to that day and renders the DAW.
   */
  function renderForDay(containerId, dateKey) {
    rootEl = document.getElementById(containerId);
    if (!rootEl) return;

    // Load template for this day
    const info = window._checkAutoModeForDay?.(dateKey);
    if (info) {
      layers = JSON.parse(JSON.stringify(info.layers));
      currentTemplate = info.templateName;
    }
    render();
  }

  // ---------------------------------------------------------------
  // EXPORTS
  // ---------------------------------------------------------------
  window.AutoSchedulePlanner = {
    init,
    render,
    renderForDay,
    generateFromLayers,
    getLayers: () => layers,
    setLayers: (l) => { layers = l; render(); },
    TILES
  };

  console.log('[AutoSchedulePlanner] v2.0 loaded');
})();
