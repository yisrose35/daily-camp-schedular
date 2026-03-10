// =================================================================
// auto_schedule_grid.js — Auto Mode Schedule Grid Renderer v1.0
// =================================================================
// Renders the generated schedule in auto mode using a time-scaled
// vertical layout. Each bunk gets its own column. Activities are
// sized proportionally to their duration. A fixed timeline ruler
// on the left shows user-configurable increments (15/30/60min).
//
// In manual mode, slots define the rows and all bunks share them.
// In auto mode, TIME defines the rows and each bunk has its own
// independently sized activity blocks within the time grid.
//
// Usage: Called by unified_schedule_system.js when auto mode is active.
//   window.AutoScheduleGrid.render(divName, divInfo, bunks, isEditable)
//
// Requires: window.scheduleAssignments, window.divisionTimes
// =================================================================

(function() {
'use strict';

// =================================================================
// CONFIGURATION
// =================================================================

var PIXELS_PER_MINUTE = 2.5; // Scale factor: 30min = 75px
var DEFAULT_INCREMENT = 30;   // Default timeline ruler increment (minutes)

// Read user preference
function getIncrement() {
    try {
        var saved = localStorage.getItem('campistry_autoGridIncrement');
        if (saved) return parseInt(saved) || DEFAULT_INCREMENT;
    } catch(e) {}
    return DEFAULT_INCREMENT;
}

function setIncrement(val) {
    try { localStorage.setItem('campistry_autoGridIncrement', String(val)); } catch(e) {}
}

// =================================================================
// TIME UTILITIES
// =================================================================

function minutesToLabel(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var ap = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ap;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =================================================================
// ACTIVITY COLORS (matches existing Campistry palette)
// =================================================================

function getBlockStyle(entry, event) {
    if (!entry && !event) return { bg: '#f3f4f6', border: '#d1d5db', text: '#6b7280' };

    var activity = (entry?._activity || entry?.field || event || '').toLowerCase();

    // Pinned/fixed events
    if (entry?._pinned || entry?._fixed) {
        if (activity.indexOf('lunch') >= 0) return { bg: '#fed7aa', border: '#f97316', text: '#7c2d12' };
        if (activity.indexOf('snack') >= 0) return { bg: '#fef08a', border: '#eab308', text: '#713f12' };
        if (activity.indexOf('dismissal') >= 0) return { bg: '#fecaca', border: '#ef4444', text: '#7f1d1d' };
        if (activity.indexOf('swim') >= 0) return { bg: '#a5f3fc', border: '#06b6d4', text: '#155e75' };
        if (activity.indexOf('change') >= 0) return { bg: '#e5e7eb', border: '#9ca3af', text: '#374151' };
        return { bg: '#e0e7ff', border: '#6366f1', text: '#312e81' };
    }

    // League
    if (entry?._h2h || activity.indexOf('league') >= 0) return { bg: '#c7d2fe', border: '#4f46e5', text: '#312e81' };

    // Special activity
    if (entry?._activity && window.RotationEngine?.isSpecialActivity?.(entry._activity)) {
        return { bg: '#ddd6fe', border: '#8b5cf6', text: '#4c1d95' };
    }

    // Free
    if (activity === 'free' || activity === 'free play' || !activity) {
        return { bg: '#f9fafb', border: '#e5e7eb', text: '#9ca3af' };
    }

    // Sport (default)
    return { bg: '#bbf7d0', border: '#22c55e', text: '#14532d' };
}

// =================================================================
// BUILD PER-BUNK ACTIVITY LIST FROM SCHEDULE ASSIGNMENTS
// =================================================================

function getBunkActivities(bunk, divName) {
    var assignments = window.scheduleAssignments || {};
    var bunkSlots = assignments[bunk];
    if (!bunkSlots || !Array.isArray(bunkSlots)) return [];
var allDivSlots = window.divisionTimes?.[divName] || [];
    var divSlots = (allDivSlots._perBunkSlots && allDivSlots._perBunkSlots[bunk])
        ? allDivSlots._perBunkSlots[bunk]
        : allDivSlots;    if (divSlots.length === 0) return [];

    var activities = [];
    var i = 0;

    while (i < bunkSlots.length && i < divSlots.length) {
        var entry = bunkSlots[i];
        var slot = divSlots[i];

        if (!entry || entry._isTransition) {
            i++;
            continue;
        }

        if (entry.continuation) {
            i++;
            continue;
        }

        // Find how far this activity spans (via continuation)
        var startIdx = i;
        var endIdx = i;
        while (endIdx + 1 < bunkSlots.length && bunkSlots[endIdx + 1]?.continuation) {
            endIdx++;
        }

        var startMin = divSlots[startIdx].startMin;
        var endMin = divSlots[endIdx].endMin;
        var duration = endMin - startMin;

        activities.push({
            startMin: startMin,
            endMin: endMin,
            duration: duration,
            entry: entry,
            activity: entry._activity || entry.field || '',
            sport: entry.sport || '',
            slotStart: startIdx,
            slotEnd: endIdx
        });

        i = endIdx + 1;
    }

    return activities;
}

// =================================================================
// RENDER DIVISION GRID (MAIN FUNCTION)
// =================================================================

function renderDivisionGrid(divName, divInfo, bunks, isEditable) {
    var container = document.createElement('div');
    container.className = 'auto-grid-division';

    // Division time range
    var divConfig = (window.divisions || {})[divName] || divInfo || {};
    var dayStart = 540, dayEnd = 960;
    if (divConfig.startTime) {
        var s = typeof divConfig.startTime === 'number' ? divConfig.startTime :
            window.AutoBuildEngine?.parseTime?.(divConfig.startTime) ||
            window.SchedulerCoreUtils?.parseTimeToMinutes?.(divConfig.startTime) || 540;
        dayStart = s;
    }
    if (divConfig.endTime) {
        var e = typeof divConfig.endTime === 'number' ? divConfig.endTime :
            window.AutoBuildEngine?.parseTime?.(divConfig.endTime) ||
            window.SchedulerCoreUtils?.parseTimeToMinutes?.(divConfig.endTime) || 960;
        dayEnd = e;
    }

    var totalMinutes = dayEnd - dayStart;
    var totalHeight = totalMinutes * PIXELS_PER_MINUTE;
    var increment = getIncrement();

    // ═══════════════════════════════════════════════
    // HEADER: Division name + increment selector
    // ═══════════════════════════════════════════════

    var divColor = divConfig.color || '#147D91';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 16px; background:' + divColor + '; color:#fff; border-radius:8px 8px 0 0;';

    var titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-weight:700; font-size:1.1rem;';
    titleEl.textContent = divName;
    header.appendChild(titleEl);

    // Increment selector
    var incWrap = document.createElement('div');
    incWrap.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:0.8rem;';
    incWrap.innerHTML = '<span style="opacity:0.8;">Grid:</span>';

    var incSelect = document.createElement('select');
    incSelect.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,0.3); background:rgba(255,255,255,0.15); color:#fff; font-size:0.8rem; cursor:pointer;';
    [15, 30, 60].forEach(function(val) {
        var opt = document.createElement('option');
        opt.value = val;
        opt.textContent = val + 'min';
        opt.style.color = '#333';
        if (val === increment) opt.selected = true;
        incSelect.appendChild(opt);
    });
    incSelect.addEventListener('change', function() {
        setIncrement(parseInt(this.value));
        // Re-render the whole schedule view
        if (window.UnifiedScheduleSystem?.renderStaggeredView) {
            window.UnifiedScheduleSystem.renderStaggeredView();
        } else if (window.updateTable) {
            window.updateTable();
        }
    });
    incWrap.appendChild(incSelect);
    header.appendChild(incWrap);
    container.appendChild(header);

    // ═══════════════════════════════════════════════
    // GRID BODY: Time ruler + bunk columns
    // ═══════════════════════════════════════════════

    var gridBody = document.createElement('div');
    gridBody.style.cssText = 'display:flex; border:1px solid #e5e7eb; border-top:none; border-radius:0 0 8px 8px; overflow-x:auto; background:#fff;';

    // ── Time Ruler Column ──
    var rulerCol = document.createElement('div');
    rulerCol.style.cssText = 'min-width:70px; width:70px; position:relative; background:#f9fafb; border-right:1px solid #e5e7eb; flex-shrink:0;';

    // Bunk header spacer
    var rulerHeader = document.createElement('div');
    rulerHeader.style.cssText = 'height:36px; border-bottom:2px solid #e5e7eb; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:600; color:#6b7280;';
    rulerHeader.textContent = 'Time';
    rulerCol.appendChild(rulerHeader);

    // Ruler body
    var rulerBody = document.createElement('div');
    rulerBody.style.cssText = 'position:relative; height:' + totalHeight + 'px;';

    for (var t = dayStart; t <= dayEnd; t += increment) {
        var top = (t - dayStart) * PIXELS_PER_MINUTE;
        var isMajor = t % 60 === 0;

        var marker = document.createElement('div');
        marker.style.cssText = 'position:absolute; top:' + top + 'px; left:0; right:0; display:flex; align-items:flex-start;';

        var label = document.createElement('span');
        label.style.cssText = 'font-size:' + (isMajor ? '0.75rem' : '0.65rem') + '; color:' + (isMajor ? '#374151' : '#9ca3af') + '; font-weight:' + (isMajor ? '600' : '400') + '; padding:1px 6px; white-space:nowrap;';
        label.textContent = minutesToLabel(t);
        marker.appendChild(label);

        rulerBody.appendChild(marker);
    }

    rulerCol.appendChild(rulerBody);
    gridBody.appendChild(rulerCol);

    // ── Bunk Columns ──
    var bunkColWidth = Math.max(90, Math.min(140, Math.floor(700 / bunks.length)));

    bunks.forEach(function(bunk) {
        var bunkCol = document.createElement('div');
        bunkCol.style.cssText = 'min-width:' + bunkColWidth + 'px; width:' + bunkColWidth + 'px; border-right:1px solid #f3f4f6; flex-shrink:0;';

        // Bunk header
        var bunkHeader = document.createElement('div');
        bunkHeader.style.cssText = 'height:36px; border-bottom:2px solid #e5e7eb; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:700; color:#1f2937; background:#f9fafb;';
        bunkHeader.textContent = bunk;
        bunkCol.appendChild(bunkHeader);

        // Bunk body — positioned blocks
        var bunkBody = document.createElement('div');
        bunkBody.style.cssText = 'position:relative; height:' + totalHeight + 'px;';

        // Draw gridlines
        for (var gt = dayStart; gt <= dayEnd; gt += increment) {
            var gtTop = (gt - dayStart) * PIXELS_PER_MINUTE;
            var gridline = document.createElement('div');
            gridline.style.cssText = 'position:absolute; top:' + gtTop + 'px; left:0; right:0; height:0; border-top:1px ' + (gt % 60 === 0 ? 'solid #e5e7eb' : 'dashed #f3f4f6') + ';';
            bunkBody.appendChild(gridline);
        }

        // Draw activity blocks
        var activities = getBunkActivities(bunk, divName);

        activities.forEach(function(act) {
            var topPx = (act.startMin - dayStart) * PIXELS_PER_MINUTE;
            var heightPx = act.duration * PIXELS_PER_MINUTE;
            if (heightPx < 2) return;

            var style = getBlockStyle(act.entry, act.activity);

            var block = document.createElement('div');
            block.style.cssText = 'position:absolute; top:' + topPx + 'px; left:3px; right:3px; height:' + (heightPx - 2) + 'px; background:' + style.bg + '; border:1px solid ' + style.border + '; border-radius:4px; overflow:hidden; cursor:pointer; display:flex; flex-direction:column; justify-content:center; padding:2px 5px; box-sizing:border-box;';

            // Activity label
            var displayName = act.entry?._activity || act.entry?.field || act.activity || '';
            var sportName = act.entry?.sport || '';

            // Build content based on available height
            var content = '';
            if (heightPx >= 40) {
                // Enough room for activity + sport + duration
                content += '<div style="font-size:0.7rem; font-weight:700; color:' + style.text + '; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(displayName) + '</div>';
                if (sportName && sportName !== displayName) {
                    content += '<div style="font-size:0.6rem; color:' + style.text + '; opacity:0.75; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(sportName) + '</div>';
                }
                content += '<div style="font-size:0.6rem; color:' + style.text + '; opacity:0.6;">' + act.duration + 'min</div>';
            } else if (heightPx >= 25) {
                // Room for activity + duration
                content += '<div style="font-size:0.65rem; font-weight:600; color:' + style.text + '; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(displayName) + '</div>';
                content += '<div style="font-size:0.55rem; color:' + style.text + '; opacity:0.6;">' + act.duration + 'm</div>';
            } else if (heightPx >= 15) {
                // Just activity name
                content += '<div style="font-size:0.6rem; font-weight:600; color:' + style.text + '; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(displayName) + '</div>';
            } else {
                // Too small — just a colored bar with tooltip
                block.title = displayName + ' (' + act.duration + 'min)';
            }

            block.innerHTML = content;

            // Tooltip on hover
            block.title = displayName + (sportName && sportName !== displayName ? ' - ' + sportName : '') +
                '\n' + minutesToLabel(act.startMin) + ' - ' + minutesToLabel(act.endMin) +
                ' (' + act.duration + 'min)';

            bunkBody.appendChild(block);
        });

        // Check for gaps (unfilled time = "Free")
        var sortedActs = activities.slice().sort(function(a, b) { return a.startMin - b.startMin; });
        var prevEnd = dayStart;
        sortedActs.forEach(function(act) {
            if (act.startMin > prevEnd + 2) {
                var gapTop = (prevEnd - dayStart) * PIXELS_PER_MINUTE;
                var gapH = (act.startMin - prevEnd) * PIXELS_PER_MINUTE;
                if (gapH > 4) {
                    var gapBlock = document.createElement('div');
                    gapBlock.style.cssText = 'position:absolute; top:' + gapTop + 'px; left:3px; right:3px; height:' + (gapH - 2) + 'px; background:repeating-linear-gradient(45deg, #f9fafb, #f9fafb 4px, #f3f4f6 4px, #f3f4f6 8px); border:1px dashed #d1d5db; border-radius:4px; display:flex; align-items:center; justify-content:center;';
                    if (gapH > 20) {
                        gapBlock.innerHTML = '<span style="font-size:0.6rem; color:#9ca3af; font-weight:500;">Free</span>';
                    }
                    gapBlock.title = 'Unassigned: ' + minutesToLabel(prevEnd) + ' - ' + minutesToLabel(act.startMin);
                    bunkBody.appendChild(gapBlock);
                }
            }
            prevEnd = Math.max(prevEnd, act.endMin);
        });
        // Gap at end of day
        if (prevEnd < dayEnd - 2) {
            var endGapTop = (prevEnd - dayStart) * PIXELS_PER_MINUTE;
            var endGapH = (dayEnd - prevEnd) * PIXELS_PER_MINUTE;
            if (endGapH > 4) {
                var endGapBlock = document.createElement('div');
                endGapBlock.style.cssText = 'position:absolute; top:' + endGapTop + 'px; left:3px; right:3px; height:' + (endGapH - 2) + 'px; background:repeating-linear-gradient(45deg, #f9fafb, #f9fafb 4px, #f3f4f6 4px, #f3f4f6 8px); border:1px dashed #d1d5db; border-radius:4px; display:flex; align-items:center; justify-content:center;';
                if (endGapH > 20) {
                    endGapBlock.innerHTML = '<span style="font-size:0.6rem; color:#9ca3af;">Free</span>';
                }
                bunkBody.appendChild(endGapBlock);
            }
        }

        bunkCol.appendChild(bunkBody);
        gridBody.appendChild(bunkCol);
    });

    container.appendChild(gridBody);

    // Shadow + spacing
    container.style.cssText = 'border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1); margin-bottom:20px; background:#fff;';

    return container;
}

// =================================================================
// PUBLIC API
// =================================================================

window.AutoScheduleGrid = {
    render: renderDivisionGrid,
    getIncrement: getIncrement,
    setIncrement: setIncrement,
    PIXELS_PER_MINUTE: PIXELS_PER_MINUTE,
    VERSION: '1.0.0'
};

console.log('[AutoScheduleGrid] v1.0.0 loaded');

})();
