// period_editor.js — Bell Schedule / Period Editor
// Manages window.campPeriods and provides a UI for the "Bell Schedule" tab.
// Periods are per-division: { divName: [{id, name, startMin, endMin}] }

(function() {
  'use strict';

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function minsToTimeStr(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    const ap = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')}${ap}`;
  }

  function parseTimePicker(value) {
    // accepts "HH:MM" (from <input type="time">) or "H:MMam/pm"
    if (!value) return null;
    const lower = value.trim().toLowerCase();
    const hasMeridiem = lower.includes('am') || lower.includes('pm');
    const isPM = lower.includes('pm');
    const clean = lower.replace(/[apm]/g, '');
    const [hStr, mStr] = clean.split(':');
    let h = parseInt(hStr, 10);
    const m = parseInt(mStr || '0', 10);
    if (isNaN(h)) return null;
    if (hasMeridiem) {
      if (isPM && h !== 12) h += 12;
      if (!isPM && h === 12) h = 0;
    }
    return h * 60 + m;
  }

  function toTimeInput(min) {
    // returns "HH:MM" for <input type="time">
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ─── Data layer ────────────────────────────────────────────────────────────

  if (!window.campPeriods) window.campPeriods = {};

  function loadAll() {
    try {
      const gs = window.loadGlobalSettings?.() || {};
      window.campPeriods = gs.campPeriods || {};
    } catch (e) {
      console.warn('[PeriodEditor] load failed', e);
    }
  }

  function saveAll() {
    try {
      window.saveGlobalSettings?.('campPeriods', window.campPeriods);
      window.dispatchEvent(new CustomEvent('campistry-periods-changed'));
    } catch (e) {
      console.warn('[PeriodEditor] save failed', e);
    }
  }

  function getPeriodsForDiv(divName) {
    return window.campPeriods[divName] || [];
  }

  function setPeriodsForDiv(divName, periods) {
    window.campPeriods[divName] = periods;
    saveAll();
  }

  function addPeriod(divName, period) {
    if (!window.campPeriods[divName]) window.campPeriods[divName] = [];
    window.campPeriods[divName].push({ id: uid(), ...period });
    saveAll();
  }

  function removePeriod(divName, id) {
    if (!window.campPeriods[divName]) return;
    window.campPeriods[divName] = window.campPeriods[divName].filter(p => p.id !== id);
    saveAll();
  }

  function updatePeriod(divName, id, changes) {
    if (!window.campPeriods[divName]) return;
    const idx = window.campPeriods[divName].findIndex(p => p.id === id);
    if (idx < 0) return;
    Object.assign(window.campPeriods[divName][idx], changes);
    saveAll();
  }

  // ─── Overlay renderer (used by master builder + daily adjustments) ─────────

  const PERIOD_COLORS = [
    { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#1d4ed8' },
    { bg: 'rgba(16,185,129,0.15)', border: '#10b981', text: '#065f46' },
    { bg: 'rgba(245,158,11,0.15)', border: '#f59e0b', text: '#92400e' },
    { bg: 'rgba(139,92,246,0.15)', border: '#8b5cf6', text: '#4c1d95' },
    { bg: 'rgba(239,68,68,0.15)',  border: '#ef4444', text: '#7f1d1d' },
    { bg: 'rgba(20,184,166,0.15)', border: '#14b8a6', text: '#0f766e' },
  ];

  function overlayPeriodsOnDAWGrid(gridEl) {
    if (!gridEl) return;
    gridEl.querySelectorAll('.period-block-overlay').forEach(el => el.remove());

    if (!window.campPeriods) return;

    // Extract globalStart from the first ruler tick
    const firstTick = gridEl.querySelector('.ms-daw-ruler-tick');
    if (!firstTick) return;

    // The ruler tick left value = (tickMin - globalStart) * PX_PER_MIN
    // For the first tick left=0 → tickMin = globalStart
    // But first tick might not be at 0 if it is a partial hour.
    // Better: scan the ruler and find the tick at left=0 or smallest left.
    let globalStart = null;
    const PX = window.MasterSchedulerInternal?.DAW_PIXELS_PER_MINUTE || 4;

    gridEl.querySelectorAll('.ms-daw-ruler-tick').forEach(tick => {
      const left = parseFloat(tick.style.left) || 0;
      if (left === 0) {
        // parse label like "9:00am" or "9:00"
        const label = tick.textContent.trim();
        const parsed = parseTimePicker(label);
        if (parsed !== null) globalStart = parsed;
      }
    });

    if (globalStart === null) return;

    Object.entries(window.campPeriods).forEach(([divName, periods]) => {
      if (!periods || periods.length === 0) return;
      const track = gridEl.querySelector(`.ms-daw-track[data-grade="${CSS.escape(divName)}"]`);
      if (!track) return;

      periods.forEach((period, idx) => {
        const clr = PERIOD_COLORS[idx % PERIOD_COLORS.length];
        const left = (period.startMin - globalStart) * PX;
        const width = (period.endMin - period.startMin) * PX;
        if (width <= 0) return;

        const el = document.createElement('div');
        el.className = 'period-block-overlay';
        el.style.cssText = [
          'position:absolute',
          `left:${left}px`,
          `width:${width}px`,
          'top:0',
          'bottom:0',
          `background:${clr.bg}`,
          `border-left:2px solid ${clr.border}`,
          `border-right:1px dashed ${clr.border}`,
          'pointer-events:none',
          'z-index:2',
          'display:flex',
          'align-items:flex-start',
          'overflow:hidden',
        ].join(';');

        const label = document.createElement('div');
        label.style.cssText = [
          `color:${clr.text}`,
          'font-size:10px',
          'font-weight:700',
          'padding:2px 4px',
          'white-space:nowrap',
          'overflow:hidden',
          'text-overflow:ellipsis',
          'max-width:100%',
          'line-height:1.2',
        ].join(';');
        label.textContent = `${period.name} (${minsToTimeStr(period.startMin)}-${minsToTimeStr(period.endMin)})`;

        el.appendChild(label);
        track.style.position = 'relative'; // ensure stacking context
        track.appendChild(el);
      });
    });
  }

  // ─── Copy modal ────────────────────────────────────────────────────────────

  function showCopyModal(sourceGrade, onApply) {
    const divisions = window.divisions || {};
    const grades = Object.keys(divisions)
      .filter(d => !divisions[d].isParent && d !== sourceGrade)
      .sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });
    if (grades.length === 0) {
      alert('No other grades to copy to.');
      return;
    }
    const sourcePeriods = window.campPeriods[sourceGrade] || [];
    if (sourcePeriods.length === 0) {
      alert('Source grade has no periods to copy.');
      return;
    }

    // Remove any existing modal
    document.querySelectorAll('.pe-copy-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'pe-copy-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:12px;max-width:460px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;';
    overlay.appendChild(modal);

    const header = document.createElement('div');
    header.style.cssText = 'padding:20px 24px 4px;';
    header.innerHTML = `
      <h3 style="margin:0 0 4px;font-size:16px;color:#1e293b;">Copy Bell Schedule</h3>
      <p style="margin:0;font-size:13px;color:#64748b;">
        Copy <strong>${sourcePeriods.length}</strong> period${sourcePeriods.length !== 1 ? 's' : ''}
        from <strong>Grade ${sourceGrade}</strong> to:
      </p>
    `;
    modal.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 24px;flex:1;overflow-y:auto;';
    modal.appendChild(body);

    const selected = new Set();

    grades.forEach(g => {
      const existingCount = (window.campPeriods[g] || []).length;
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;user-select:none;margin-bottom:6px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'width:16px;height:16px;accent-color:#3b82f6;';
      cb.onchange = () => {
        if (cb.checked) selected.add(g); else selected.delete(g);
        applyBtn.disabled = selected.size === 0;
      };
      const label = document.createElement('span');
      label.style.cssText = 'font-size:14px;color:#1f2937;flex:1;';
      label.textContent = `Grade ${g}`;
      row.appendChild(cb);
      row.appendChild(label);
      if (existingCount > 0) {
        const warn = document.createElement('span');
        warn.style.cssText = 'font-size:11px;color:#d97706;';
        warn.textContent = `${existingCount} period${existingCount !== 1 ? 's' : ''} (will be replaced)`;
        row.appendChild(warn);
      }
      body.appendChild(row);
    });

    // Select-all link
    const selectAllRow = document.createElement('div');
    selectAllRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px;';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.style.cssText = 'font-size:12px;color:#3b82f6;background:none;border:none;cursor:pointer;text-decoration:underline;font-weight:600;';
    selectAllBtn.onclick = () => {
      body.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
        selected.add(cb.parentElement.querySelector('span').textContent.replace('Grade ', ''));
      });
      applyBtn.disabled = false;
    };
    selectAllRow.appendChild(selectAllBtn);
    body.appendChild(selectAllRow);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:14px 24px;border-top:1px solid #e5e7eb;background:#f8fafc;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;';
    cancelBtn.onclick = () => overlay.remove();
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Copy';
    applyBtn.disabled = true;
    applyBtn.style.cssText = 'background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;';
    applyBtn.onclick = () => {
      if (selected.size === 0) return;
      // Deep-copy source periods, regenerate ids per target so each grade
      // has its own period instances.
      selected.forEach(targetGrade => {
        const copies = sourcePeriods.map(p => ({
          id: uid(),
          name: p.name,
          startMin: p.startMin,
          endMin: p.endMin
        }));
        setPeriodsForDiv(targetGrade, copies);
      });
      overlay.remove();
      if (typeof onApply === 'function') onApply();
    };
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    modal.appendChild(footer);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }

  // ─── Editor UI ─────────────────────────────────────────────────────────────

  function renderEditor(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = '';

    const divisions = window.divisions || {};
    const grades = Object.keys(divisions)
      .filter(d => !divisions[d].isParent)
      .sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });

    if (grades.length === 0) {
      containerEl.innerHTML = '<p style="color:#94a3b8;padding:24px;">No grades configured. Go to Setup first.</p>';
      return;
    }

    // Outer shell
    const shell = document.createElement('div');
    shell.style.cssText = 'display:flex;gap:0;height:100%;';

    // Left: grade list
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:160px;flex-shrink:0;border-right:1px solid #e2e8f0;overflow-y:auto;background:#f8fafc;';
    sidebar.innerHTML = `<div style="padding:12px 16px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:.06em;text-transform:uppercase;">Grades</div>`;

    // Right: detail
    const detail = document.createElement('div');
    detail.style.cssText = 'flex:1;overflow-y:auto;padding:24px;';

    let activeGrade = grades[0];

    function renderGradeSidebar() {
      sidebar.querySelectorAll('.pe-grade-btn').forEach(b => b.remove());
      grades.forEach(g => {
        const periodCount = (window.campPeriods[g] || []).length;
        const btn = document.createElement('button');
        btn.className = 'pe-grade-btn';
        btn.style.cssText = [
          'display:block;width:100%;text-align:left;padding:10px 16px',
          'border:none;background:' + (g === activeGrade ? '#eff6ff' : 'transparent'),
          'color:' + (g === activeGrade ? '#2563eb' : '#334155'),
          'font-weight:' + (g === activeGrade ? '700' : '500'),
          'font-size:13px;cursor:pointer;border-left:3px solid ' + (g === activeGrade ? '#3b82f6' : 'transparent'),
        ].join(';');
        btn.textContent = g;
        if (periodCount > 0) {
          const badge = document.createElement('span');
          badge.textContent = periodCount;
          badge.style.cssText = 'float:right;background:#dbeafe;color:#1d4ed8;font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;';
          btn.appendChild(badge);
        }
        btn.onclick = () => { activeGrade = g; renderGradeSidebar(); renderGradeDetail(); };
        sidebar.appendChild(btn);
      });
    }

    function renderGradeDetail() {
      detail.innerHTML = '';

      const div = divisions[activeGrade] || {};
      const divStartMin = parseTimePicker(div.startTime) || 540;
      const divEndMin = parseTimePicker(div.endTime) || 960;
      const periods = window.campPeriods[activeGrade] || [];

      // Header
      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:20px;';
      hdr.innerHTML = `
        <h3 style="margin:0;font-size:16px;color:#1e293b;">Grade ${activeGrade} — Bell Schedule</h3>
        <span style="font-size:12px;color:#64748b;">${minsToTimeStr(divStartMin)} – ${minsToTimeStr(divEndMin)}</span>
      `;
      detail.appendChild(hdr);

      // Action row: Add + Copy
      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;';

      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Period';
      addBtn.style.cssText = 'background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;';
      addBtn.onclick = () => {
        // Default: place after last period or start of division
        const lastPeriod = periods[periods.length - 1];
        const defaultStart = lastPeriod ? lastPeriod.endMin : divStartMin;
        const defaultEnd = Math.min(defaultStart + 40, divEndMin);
        const nextNum = periods.length + 1;
        addPeriod(activeGrade, {
          name: `Period ${nextNum}`,
          startMin: defaultStart,
          endMin: defaultEnd,
        });
        renderGradeDetail();
        renderGradeSidebar();
      };
      actionRow.appendChild(addBtn);

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy to Grades…';
      copyBtn.style.cssText = 'background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;';
      copyBtn.disabled = periods.length === 0 || grades.length < 2;
      if (copyBtn.disabled) copyBtn.style.opacity = '0.5';
      copyBtn.onclick = () => showCopyModal(activeGrade, () => {
        renderGradeSidebar();
        renderGradeDetail();
      });
      actionRow.appendChild(copyBtn);

      detail.appendChild(actionRow);

      if (periods.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:#94a3b8;font-size:14px;';
        empty.textContent = 'No periods defined. Click "+ Add Period" to create your first bell.';
        detail.appendChild(empty);
        return;
      }

      // Sort periods by startMin for display
      const sorted = [...periods].sort((a, b) => a.startMin - b.startMin);

      sorted.forEach((period, idx) => {
        const clr = PERIOD_COLORS[idx % PERIOD_COLORS.length];
        const card = document.createElement('div');
        card.style.cssText = [
          'border:1px solid #e2e8f0',
          'border-left:4px solid ' + clr.border,
          'border-radius:8px',
          'padding:14px 16px',
          'margin-bottom:12px',
          'background:#fff',
          'display:flex',
          'gap:12px',
          'align-items:center',
          'flex-wrap:wrap',
        ].join(';');

        // Period number
        const numBadge = document.createElement('div');
        numBadge.style.cssText = `background:${clr.bg};color:${clr.text};font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;white-space:nowrap;flex-shrink:0;`;
        numBadge.textContent = `P${idx + 1}`;
        card.appendChild(numBadge);

        // Name field
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = period.name;
        nameInput.placeholder = 'Period name';
        nameInput.style.cssText = 'border:1px solid #cbd5e1;border-radius:6px;padding:6px 10px;font-size:13px;width:120px;flex-shrink:0;';
        nameInput.onchange = () => updatePeriod(activeGrade, period.id, { name: nameInput.value });
        card.appendChild(nameInput);

        // Start time
        const startLabel = document.createElement('label');
        startLabel.style.cssText = 'font-size:12px;color:#64748b;display:flex;flex-direction:column;gap:2px;';
        startLabel.textContent = 'Start';
        const startInput = document.createElement('input');
        startInput.type = 'time';
        startInput.value = toTimeInput(period.startMin);
        startInput.style.cssText = 'border:1px solid #cbd5e1;border-radius:6px;padding:5px 8px;font-size:13px;';
        startInput.onchange = () => {
          const val = parseTimePicker(startInput.value);
          if (val !== null) updatePeriod(activeGrade, period.id, { startMin: val });
        };
        startLabel.appendChild(startInput);
        card.appendChild(startLabel);

        // End time
        const endLabel = document.createElement('label');
        endLabel.style.cssText = 'font-size:12px;color:#64748b;display:flex;flex-direction:column;gap:2px;';
        endLabel.textContent = 'End';
        const endInput = document.createElement('input');
        endInput.type = 'time';
        endInput.value = toTimeInput(period.endMin);
        endInput.style.cssText = 'border:1px solid #cbd5e1;border-radius:6px;padding:5px 8px;font-size:13px;';
        endInput.onchange = () => {
          const val = parseTimePicker(endInput.value);
          if (val !== null) updatePeriod(activeGrade, period.id, { endMin: val });
        };
        endLabel.appendChild(endInput);
        card.appendChild(endLabel);

        // Duration display
        const durSpan = document.createElement('span');
        durSpan.style.cssText = 'font-size:12px;color:#64748b;white-space:nowrap;margin-left:4px;';
        durSpan.textContent = `${period.endMin - period.startMin} min`;
        // Update duration label live
        const updateDur = () => {
          const s = parseTimePicker(startInput.value);
          const e = parseTimePicker(endInput.value);
          if (s !== null && e !== null) durSpan.textContent = `${e - s} min`;
        };
        startInput.addEventListener('input', updateDur);
        endInput.addEventListener('input', updateDur);
        card.appendChild(durSpan);

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Remove';
        delBtn.style.cssText = 'margin-left:auto;background:#fee2e2;color:#dc2626;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;';
        delBtn.onclick = () => {
          removePeriod(activeGrade, period.id);
          renderGradeDetail();
          renderGradeSidebar();
        };
        card.appendChild(delBtn);

        detail.appendChild(card);
      });

      // Mini visual timeline preview
      const totalSpan = divEndMin - divStartMin;
      if (totalSpan > 0 && periods.length > 0) {
        const previewWrap = document.createElement('div');
        previewWrap.style.cssText = 'margin-top:20px;';

        const previewTitle = document.createElement('div');
        previewTitle.style.cssText = 'font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;';
        previewTitle.textContent = 'Timeline Preview';
        previewWrap.appendChild(previewTitle);

        const bar = document.createElement('div');
        bar.style.cssText = 'position:relative;height:32px;background:#f1f5f9;border-radius:6px;overflow:hidden;';

        sorted.forEach((p, i) => {
          const clr2 = PERIOD_COLORS[i % PERIOD_COLORS.length];
          const leftPct = ((p.startMin - divStartMin) / totalSpan * 100).toFixed(2);
          const widthPct = ((p.endMin - p.startMin) / totalSpan * 100).toFixed(2);
          const seg = document.createElement('div');
          seg.style.cssText = [
            'position:absolute',
            `left:${leftPct}%`,
            `width:${widthPct}%`,
            'top:0;bottom:0',
            `background:${clr2.border}`,
            'opacity:0.7',
            'display:flex;align-items:center;justify-content:center',
            'overflow:hidden',
          ].join(';');
          const lbl = document.createElement('span');
          lbl.style.cssText = 'font-size:10px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px;';
          lbl.textContent = p.name;
          seg.appendChild(lbl);
          bar.appendChild(seg);
        });

        // Gap zones (time not covered by any period)
        previewWrap.appendChild(bar);

        // Time labels
        const timeRow = document.createElement('div');
        timeRow.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-top:4px;';
        timeRow.innerHTML = `<span>${minsToTimeStr(divStartMin)}</span><span>${minsToTimeStr(divEndMin)}</span>`;
        previewWrap.appendChild(timeRow);

        detail.appendChild(previewWrap);
      }
    }

    shell.appendChild(sidebar);
    shell.appendChild(detail);
    containerEl.appendChild(shell);

    renderGradeSidebar();
    renderGradeDetail();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  window.PeriodEditor = {
    load: loadAll,
    save: saveAll,
    getPeriodsForDiv,
    setPeriodsForDiv,
    addPeriod,
    removePeriod,
    updatePeriod,
    renderEditor,
    overlayPeriodsOnDAWGrid,
  };

  // Auto-load on startup
  loadAll();

  // Reload when settings change externally
  window.addEventListener('campistry-cloud-settings-loaded', loadAll);

})();
