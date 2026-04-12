// =================================================================
// rotation_events.js  (v1.0 — Camp-Wide Rotation Events)
// =================================================================
// Camp-wide activities that every bunk must pass through once,
// staggered across a date range within a daily time window.
// Examples: lice checking, health screenings, photo day, fittings.
//
// Data stored in: globalSettings.rotationEvents[]
// UI lives in: Daily Adjustments → "Rotation Events" subtab
// Scheduler integration: window.RotationEvents.getAssignmentsForDate()
// =================================================================
(function () {
'use strict';

const STORAGE_KEY = 'rotationEvents';
const EVT_COLOR_PALETTE = ['#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#06B6D4', '#EF4444'];

// =================================================================
// DATA: Load / Save
// =================================================================

function loadRotationEvents() {
    const g = window.loadGlobalSettings?.() || {};
    return Array.isArray(g.rotationEvents) ? g.rotationEvents : [];
}

function saveRotationEvents(events) {
    const g = window.loadGlobalSettings?.() || {};
    g.rotationEvents = events;
    window.saveGlobalSettings?.('rotationEvents', events);
    window.forceSyncToCloud?.();
}

function getEventById(id) {
    return loadRotationEvents().find(e => e.id === id) || null;
}

function updateEvent(id, patch) {
    const events = loadRotationEvents();
    const idx = events.findIndex(e => e.id === id);
    if (idx < 0) return;
    Object.assign(events[idx], patch);
    saveRotationEvents(events);
}

function deleteEvent(id) {
    const events = loadRotationEvents().filter(e => e.id !== id);
    saveRotationEvents(events);
}

// =================================================================
// HELPERS
// =================================================================

function generateId() {
    return 'rot_evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getAllBunks() {
    const g = window.loadGlobalSettings?.() || {};
    const divisions = g.app1?.divisions || {};
    const availDiv = g.app1?.availableDivisions || window.availableDivisions || [];
    const bunks = [];
    availDiv.forEach(divName => {
        const divBunks = divisions[divName]?.bunks || [];
        divBunks.forEach(b => bunks.push({ bunk: b, grade: divName }));
    });
    return bunks;
}

function getBunkGrade(bunkName) {
    const all = getAllBunks();
    const found = all.find(b => b.bunk === bunkName);
    return found ? found.grade : null;
}

function minutesToTime(min) {
    let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + m.toString().padStart(2, '0') + ap;
}

function parseTimeToMinutes(str) {
    if (typeof str === 'number') return str;
    if (!str) return null;
    let s = str.toLowerCase().trim();
    let mer = null;
    if (s.includes('am')) mer = 'am';
    else if (s.includes('pm')) mer = 'pm';
    s = s.replace(/am|pm/g, '').trim();
    const m = s.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
    if (!m) return null;
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || mm < 0 || mm > 59) return null;
    if (mer) {
        if (hh === 12) hh = mer === 'am' ? 0 : 12;
        else if (mer === 'pm') hh += 12;
    }
    return hh * 60 + mm;
}

function isDateInRange(dateKey, start, end) {
    return dateKey >= start && dateKey <= end;
}

function getCompletedBunks(evt) {
    if (!evt.completedBunks) return new Set();
    const all = new Set();
    Object.values(evt.completedBunks).forEach(arr => {
        if (Array.isArray(arr)) arr.forEach(b => all.add(b));
    });
    return all;
}

function getRemainingBunks(evt) {
    const allBunks = getAllBunks();
    const excluded = new Set(evt.excludedBunks || []);
    const completed = getCompletedBunks(evt);
    return allBunks.filter(b => !excluded.has(b.bunk) && !completed.has(b.bunk));
}

function getDatesBetween(start, end) {
    const dates = [];
    let d = new Date(start + 'T00:00:00');
    const endD = new Date(end + 'T00:00:00');
    while (d <= endD) {
        dates.push(d.toISOString().split('T')[0]);
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

// =================================================================
// SCHEDULING ENGINE
// =================================================================

/**
 * For a given date, compute which bunks should be assigned to which time slots.
 * Returns: { eventId, eventName, assignments: [{ bunk, grade, startMin, endMin }], location, color }[]
 */
function getAssignmentsForDate(dateKey, opts = {}) {
    const events = loadRotationEvents();
    const results = [];

    events.forEach(evt => {
        if (!isDateInRange(dateKey, evt.dateRange.start, evt.dateRange.end)) return;

        const remaining = getRemainingBunks(evt);
        if (remaining.length === 0) return;

        // Determine which bunks to schedule today
        let todayQueue;
        if (opts.manualBunks && opts.manualBunks[evt.id]) {
            // Semi-auto: user picked specific bunks
            const picked = new Set(opts.manualBunks[evt.id]);
            todayQueue = remaining.filter(b => picked.has(b.bunk));
        } else if (opts.autoFill !== false) {
            // Auto: take as many as can fit
            todayQueue = [...remaining];
        } else {
            return; // No bunks selected and auto disabled
        }

        // Sort by grade for grouping, then by bunk name within grade
        todayQueue.sort((a, b) => {
            if (a.grade !== b.grade) return a.grade.localeCompare(b.grade);
            const numA = parseInt(a.bunk.match(/\d+/)?.[0] || 0);
            const numB = parseInt(b.bunk.match(/\d+/)?.[0] || 0);
            return numA - numB || a.bunk.localeCompare(b.bunk);
        });

        const windowStart = evt.dailyWindow.startMin;
        const windowEnd = evt.dailyWindow.endMin;
        const duration = evt.durationPerBunk;
        const concurrency = evt.concurrency || 1;

        // Build time slots
        const totalSlots = Math.floor((windowEnd - windowStart) / duration);
        const assignments = [];
        let slotIdx = 0;
        let concurrencySlot = 0;

        // Get existing schedules for conflict checking
        const scheduleAssignments = window.scheduleAssignments || {};

        for (let i = 0; i < todayQueue.length && slotIdx < totalSlots; i++) {
            const bunkInfo = todayQueue[i];
            const slotStart = windowStart + slotIdx * duration;
            const slotEnd = slotStart + duration;

            // Check conflict with existing fixed blocks
            if (hasBunkConflict(bunkInfo.bunk, slotStart, slotEnd, scheduleAssignments, opts.timelines)) {
                // Try next slots for this bunk
                let placed = false;
                for (let s = slotIdx + 1; s < totalSlots; s++) {
                    const altStart = windowStart + s * duration;
                    const altEnd = altStart + duration;
                    if (!hasBunkConflict(bunkInfo.bunk, altStart, altEnd, scheduleAssignments, opts.timelines)) {
                        assignments.push({
                            bunk: bunkInfo.bunk,
                            grade: bunkInfo.grade,
                            startMin: altStart,
                            endMin: altEnd
                        });
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    // Can't fit today — skip this bunk (overflow to next day)
                    continue;
                }
            } else {
                assignments.push({
                    bunk: bunkInfo.bunk,
                    grade: bunkInfo.grade,
                    startMin: slotStart,
                    endMin: slotEnd
                });
            }

            concurrencySlot++;
            if (concurrencySlot >= concurrency) {
                concurrencySlot = 0;
                slotIdx++;
            }
        }

        if (assignments.length > 0) {
            results.push({
                eventId: evt.id,
                eventName: evt.name,
                assignments,
                location: evt.location || null,
                color: evt.color || '#F59E0B',
                durationPerBunk: evt.durationPerBunk,
                concurrency: evt.concurrency
            });
        }
    });

    return results;
}

/**
 * Check if a bunk has a fixed block (swim, lunch, snack, dismissal, pinned)
 * that overlaps the given time range.
 */
function hasBunkConflict(bunkName, startMin, endMin, scheduleAssignments, timelines) {
    // Check from auto-build timelines first (if available during auto-scheduling)
    if (timelines && timelines[bunkName]) {
        const tl = timelines[bunkName];
        for (const block of tl) {
            if (!block || block._isTransition) continue;
            const bStart = block.startMin ?? block._startMin;
            const bEnd = block.endMin ?? block._endMin;
            if (bStart == null || bEnd == null) continue;
            // Only conflict with fixed/locked blocks
            if (block._activityLocked || block._isFixed || block.type === 'pinned') {
                if (bStart < endMin && bEnd > startMin) return true;
            }
        }
        return false;
    }

    // Fallback: check scheduleAssignments
    const sched = scheduleAssignments[bunkName];
    if (!Array.isArray(sched)) return false;
    for (const entry of sched) {
        if (!entry || entry.continuation || entry._isTransition) continue;
        const eStart = entry.startMin ?? entry._startMin;
        const eEnd = entry.endMin ?? entry._endMin;
        if (eStart == null || eEnd == null) continue;
        if (entry._activityLocked || entry._isFixed || entry.type === 'pinned') {
            if (eStart < endMin && eEnd > startMin) return true;
        }
    }
    return false;
}

/**
 * After scheduling, mark bunks as completed for a date.
 */
function markCompleted(eventId, dateKey, bunkNames) {
    const events = loadRotationEvents();
    const evt = events.find(e => e.id === eventId);
    if (!evt) return;
    if (!evt.completedBunks) evt.completedBunks = {};
    if (!evt.completedBunks[dateKey]) evt.completedBunks[dateKey] = [];
    bunkNames.forEach(b => {
        if (!evt.completedBunks[dateKey].includes(b)) {
            evt.completedBunks[dateKey].push(b);
        }
    });
    saveRotationEvents(events);
}

/**
 * Write rotation event blocks into bunk timelines (for auto-scheduler integration).
 * Called from scheduler_core_auto.js after the main scheduling pass.
 */
function writeBlocksToTimelines(dateKey, timelines, opts = {}) {
    const allAssignments = getAssignmentsForDate(dateKey, { ...opts, timelines });
    const written = [];

    allAssignments.forEach(result => {
        result.assignments.forEach(a => {
            if (!timelines[a.bunk]) return;

            const block = {
                _activity: result.eventName,
                field: result.location || result.eventName,
                startMin: a.startMin,
                endMin: a.endMin,
                _startMin: a.startMin,
                _endMin: a.endMin,
                _isRotationEvent: true,
                _rotationEventId: result.eventId,
                _autoMode: true,
                _activityLocked: false,
                displayName: result.eventName,
                _color: result.color,
                type: 'rotation_event'
            };

            // Insert into timeline at the correct position
            const tl = timelines[a.bunk];
            let insertIdx = tl.length;
            for (let i = 0; i < tl.length; i++) {
                const existing = tl[i];
                const eStart = existing?.startMin ?? existing?._startMin ?? Infinity;
                if (a.startMin < eStart) { insertIdx = i; break; }
            }
            tl.splice(insertIdx, 0, block);

            written.push({ bunk: a.bunk, block });
        });

        // Mark completed
        const bunkNames = result.assignments.map(a => a.bunk);
        markCompleted(result.eventId, dateKey, bunkNames);
    });

    return written;
}

// =================================================================
// UI: Daily Adjustments Pane
// =================================================================

function renderRotationEventsPane(containerEl) {
    if (!containerEl) return;
    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    const events = loadRotationEvents();
    const activeEvents = events.filter(e => isDateInRange(dateKey, e.dateRange.start, e.dateRange.end));
    const upcomingEvents = events.filter(e => e.dateRange.start > dateKey);
    const pastEvents = events.filter(e => e.dateRange.end < dateKey);

    containerEl.innerHTML = `
        <div style="padding:16px;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
                <div>
                    <h3 style="margin:0; font-size:15px; font-weight:600; color:#0f172a;">Rotation Events</h3>
                    <p style="margin:4px 0 0; font-size:12px; color:#64748b;">Camp-wide activities every bunk passes through</p>
                </div>
                <button id="re-add-event-btn" class="da-btn da-btn-primary" style="font-size:12px; padding:8px 14px;">
                    + New Event
                </button>
            </div>

            ${activeEvents.length > 0 ? `
                <div style="margin-bottom:20px;">
                    <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#059669; margin-bottom:8px;">
                        Active Today
                    </div>
                    <div id="re-active-events"></div>
                </div>
            ` : `
                <div style="padding:24px; text-align:center; background:#f8fafc; border-radius:10px; border:1px dashed #e2e8f0; margin-bottom:20px;">
                    <div style="font-size:24px; margin-bottom:8px;">📋</div>
                    <div style="font-size:13px; color:#64748b;">No rotation events active for today</div>
                </div>
            `}

            ${upcomingEvents.length > 0 ? `
                <div style="margin-bottom:20px;">
                    <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#6366f1; margin-bottom:8px;">
                        Upcoming
                    </div>
                    <div id="re-upcoming-events"></div>
                </div>
            ` : ''}

            ${pastEvents.length > 0 ? `
                <details style="margin-bottom:12px;">
                    <summary style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8; cursor:pointer; margin-bottom:8px;">
                        Past Events (${pastEvents.length})
                    </summary>
                    <div id="re-past-events"></div>
                </details>
            ` : ''}
        </div>
    `;

    // Render event cards
    if (activeEvents.length > 0) {
        const activeContainer = containerEl.querySelector('#re-active-events');
        activeEvents.forEach(evt => activeContainer.appendChild(renderEventCard(evt, dateKey, true)));
    }
    if (upcomingEvents.length > 0) {
        const upcomingContainer = containerEl.querySelector('#re-upcoming-events');
        upcomingEvents.forEach(evt => upcomingContainer.appendChild(renderEventCard(evt, dateKey, false)));
    }
    if (pastEvents.length > 0) {
        const pastContainer = containerEl.querySelector('#re-past-events');
        pastEvents.forEach(evt => pastContainer.appendChild(renderEventCard(evt, dateKey, false)));
    }

    // Add event button
    containerEl.querySelector('#re-add-event-btn').onclick = () => showCreateEventModal(containerEl);
}

function renderEventCard(evt, dateKey, isActive) {
    const card = document.createElement('div');
    const allBunks = getAllBunks();
    const excluded = new Set(evt.excludedBunks || []);
    const totalBunks = allBunks.filter(b => !excluded.has(b.bunk)).length;
    const completed = getCompletedBunks(evt);
    const completedCount = [...completed].filter(b => !excluded.has(b)).length;
    const remaining = getRemainingBunks(evt);
    const progressPct = totalBunks > 0 ? Math.round((completedCount / totalBunks) * 100) : 0;
    const dates = getDatesBetween(evt.dateRange.start, evt.dateRange.end);
    const dayNum = dates.indexOf(dateKey) + 1;
    const totalDays = dates.length;

    card.style.cssText = 'background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px; margin-bottom:10px; border-left:4px solid ' + (evt.color || '#F59E0B') + ';';
    card.innerHTML = `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:10px;">
            <div>
                <div style="font-weight:600; font-size:14px; color:#0f172a;">${escapeHtml(evt.name)}</div>
                <div style="font-size:11px; color:#64748b; margin-top:2px;">
                    ${minutesToTime(evt.dailyWindow.startMin)} – ${minutesToTime(evt.dailyWindow.endMin)}
                    · ${evt.durationPerBunk}min/bunk · ${evt.concurrency} at a time
                    ${evt.location ? ' · 📍 ' + escapeHtml(evt.location) : ''}
                </div>
            </div>
            <div style="display:flex; gap:4px;">
                ${isActive ? `<button class="re-autofill-btn da-btn da-btn-ghost" data-id="${evt.id}" style="font-size:11px; padding:4px 8px;" title="Auto-fill today's batch">⚡ Auto-fill</button>` : ''}
                <button class="re-edit-btn da-btn da-btn-ghost" data-id="${evt.id}" style="font-size:11px; padding:4px 8px;">✏️</button>
                <button class="re-delete-btn da-btn da-btn-ghost" data-id="${evt.id}" style="font-size:11px; padding:4px 8px; color:#ef4444;">🗑</button>
            </div>
        </div>

        <!-- Progress -->
        <div style="margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; font-size:11px; color:#64748b; margin-bottom:4px;">
                <span>${completedCount}/${totalBunks} bunks done</span>
                <span>${isActive ? 'Day ' + dayNum + '/' + totalDays : evt.dateRange.start + ' → ' + evt.dateRange.end}</span>
            </div>
            <div style="height:6px; background:#f1f5f9; border-radius:3px; overflow:hidden;">
                <div style="height:100%; width:${progressPct}%; background:${evt.color || '#F59E0B'}; border-radius:3px; transition:width 0.3s;"></div>
            </div>
        </div>

        ${completedCount >= totalBunks ? `
            <div style="padding:8px 12px; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:6px; font-size:12px; color:#065f46; text-align:center;">
                ✅ All bunks completed!
            </div>
        ` : isActive ? `
            <!-- Remaining bunks (checkboxes for semi-auto) -->
            <details>
                <summary style="font-size:12px; font-weight:500; color:#334155; cursor:pointer; margin-bottom:6px;">
                    Remaining bunks (${remaining.length}) — click to select for today
                </summary>
                <div class="re-bunk-checklist" data-id="${evt.id}" style="max-height:200px; overflow-y:auto; padding:8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0; margin-top:6px;">
                    ${renderBunkChecklist(remaining, evt, dateKey)}
                </div>
            </details>
        ` : ''}
    `;

    // Bind events
    card.querySelector('.re-delete-btn')?.addEventListener('click', async () => {
        if (typeof window.daShowConfirm === 'function') {
            const ok = await window.daShowConfirm('Delete rotation event "' + evt.name + '"? This cannot be undone.', { danger: true, confirmText: 'Delete' });
            if (ok) { deleteEvent(evt.id); renderRotationEventsPane(card.closest('#da-rotation-events-container')); }
        } else {
            if (confirm('Delete "' + evt.name + '"?')) { deleteEvent(evt.id); renderRotationEventsPane(card.closest('#da-rotation-events-container')); }
        }
    });

    card.querySelector('.re-edit-btn')?.addEventListener('click', () => {
        showEditEventModal(evt, card.closest('#da-rotation-events-container'));
    });

    card.querySelector('.re-autofill-btn')?.addEventListener('click', () => {
        autoFillToday(evt, dateKey, card.closest('#da-rotation-events-container'));
    });

    return card;
}

function renderBunkChecklist(remaining, evt, dateKey) {
    // Group by grade
    const byGrade = {};
    remaining.forEach(b => {
        if (!byGrade[b.grade]) byGrade[b.grade] = [];
        byGrade[b.grade].push(b.bunk);
    });

    // Load today's manual picks (if any)
    const dailyData = window.loadCurrentDailyData?.() || {};
    const manualPicks = dailyData.rotationEventPicks || {};
    const todayPicks = new Set(manualPicks[evt.id] || []);

    let html = '';
    Object.keys(byGrade).sort().forEach(grade => {
        html += `<div style="font-size:10px; font-weight:600; text-transform:uppercase; color:#94a3b8; margin:6px 0 4px; letter-spacing:0.05em;">${escapeHtml(grade)}</div>`;
        html += '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(100px, 1fr)); gap:4px;">';
        byGrade[grade].sort().forEach(bunk => {
            const checked = todayPicks.has(bunk) ? 'checked' : '';
            html += `
                <label style="display:flex; align-items:center; gap:6px; padding:4px 8px; background:#fff; border-radius:4px; cursor:pointer; font-size:12px; border:1px solid #e2e8f0;">
                    <input type="checkbox" class="re-bunk-cb" data-bunk="${escapeHtml(bunk)}" data-evt="${evt.id}" ${checked}>
                    <span>${escapeHtml(bunk)}</span>
                </label>
            `;
        });
        html += '</div>';
    });

    // Bind checkbox events (deferred)
    setTimeout(() => {
        document.querySelectorAll('.re-bunk-cb[data-evt="' + evt.id + '"]').forEach(cb => {
            cb.onchange = () => {
                const picks = [];
                document.querySelectorAll('.re-bunk-cb[data-evt="' + evt.id + '"]:checked').forEach(c => {
                    picks.push(c.dataset.bunk);
                });
                // Save picks to daily data
                const dd = window.loadCurrentDailyData?.() || {};
                if (!dd.rotationEventPicks) dd.rotationEventPicks = {};
                dd.rotationEventPicks[evt.id] = picks;
                window.saveCurrentDailyData?.('rotationEventPicks', dd.rotationEventPicks);
            };
        });
    }, 100);

    return html;
}

function autoFillToday(evt, dateKey, containerEl) {
    const remaining = getRemainingBunks(evt);
    if (remaining.length === 0) return;

    // Compute how many can fit in today's window
    const windowMinutes = evt.dailyWindow.endMin - evt.dailyWindow.startMin;
    const slotsPerRound = evt.concurrency || 1;
    const totalRounds = Math.floor(windowMinutes / evt.durationPerBunk);
    const maxBunks = totalRounds * slotsPerRound;

    // Select up to maxBunks, grade-grouped
    const sorted = [...remaining].sort((a, b) => {
        if (a.grade !== b.grade) return a.grade.localeCompare(b.grade);
        return a.bunk.localeCompare(b.bunk);
    });
    const todayBatch = sorted.slice(0, maxBunks).map(b => b.bunk);

    // Save as manual picks
    const dd = window.loadCurrentDailyData?.() || {};
    if (!dd.rotationEventPicks) dd.rotationEventPicks = {};
    dd.rotationEventPicks[evt.id] = todayBatch;
    window.saveCurrentDailyData?.('rotationEventPicks', dd.rotationEventPicks);

    // Re-render
    renderRotationEventsPane(containerEl);

    const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
    alertFn('⚡ Auto-filled ' + todayBatch.length + ' bunks for today (' + remaining.length + ' remaining total).');
}

// =================================================================
// UI: Create / Edit Event Modal
// =================================================================

async function showCreateEventModal(containerEl) {
    const g = window.loadGlobalSettings?.() || {};
    const allFields = (g.app1?.fields || []).map(f => f.name).sort();
    const allBunks = getAllBunks();

    const showModal = typeof window.daShowModal === 'function' ? window.daShowModal : null;
    if (!showModal) { alert('Modal system not available'); return; }

    const result = await showModal({
        title: 'New Rotation Event',
        description: 'A camp-wide activity that every bunk passes through once over a date range.',
        wide: true,
        fields: [
            { name: 'name', label: 'Event Name', type: 'text', placeholder: 'e.g., Lice Checking, Photo Day' },
            { name: 'startDate', label: 'Start Date', type: 'text', placeholder: 'YYYY-MM-DD', default: window.currentScheduleDate || '' },
            { name: 'endDate', label: 'End Date', type: 'text', placeholder: 'YYYY-MM-DD' },
            { name: 'windowStart', label: 'Daily Window Start', type: 'text', placeholder: 'e.g., 11:00am' },
            { name: 'windowEnd', label: 'Daily Window End', type: 'text', placeholder: 'e.g., 1:00pm' },
            { name: 'duration', label: 'Duration Per Bunk (minutes)', type: 'text', placeholder: 'e.g., 10' },
            { name: 'concurrency', label: 'Bunks at a Time', type: 'text', placeholder: 'e.g., 2', default: '2' },
            { name: 'location', label: 'Location (optional)', type: 'select', options: [{ value: '', label: '-- None --' }, ...allFields.map(f => ({ value: f, label: f }))] }
        ],
        confirmText: 'Create Event'
    });

    if (!result || !result.name || !result.startDate || !result.endDate || !result.windowStart || !result.windowEnd || !result.duration) return;

    const windowStartMin = parseTimeToMinutes(result.windowStart);
    const windowEndMin = parseTimeToMinutes(result.windowEnd);
    if (windowStartMin == null || windowEndMin == null || windowEndMin <= windowStartMin) {
        const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
        alertFn('Invalid time window. End must be after start.');
        return;
    }

    const duration = parseInt(result.duration);
    const concurrency = Math.max(1, parseInt(result.concurrency) || 2);
    if (isNaN(duration) || duration < 1) {
        const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
        alertFn('Duration must be a positive number.');
        return;
    }

    // Validate dates
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(result.endDate)) {
        const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
        alertFn('Dates must be in YYYY-MM-DD format.');
        return;
    }
    if (result.endDate < result.startDate) {
        const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
        alertFn('End date must be on or after start date.');
        return;
    }

    const newEvent = {
        id: generateId(),
        name: result.name.trim(),
        dateRange: { start: result.startDate, end: result.endDate },
        dailyWindow: { startMin: windowStartMin, endMin: windowEndMin },
        durationPerBunk: duration,
        concurrency,
        location: result.location || null,
        gradeGrouping: true,
        excludedBunks: [],
        completedBunks: {},
        color: EVT_COLOR_PALETTE[loadRotationEvents().length % EVT_COLOR_PALETTE.length]
    };

    const events = loadRotationEvents();
    events.push(newEvent);
    saveRotationEvents(events);

    renderRotationEventsPane(containerEl);

    // Show summary
    const totalBunks = getAllBunks().length;
    const windowMinutes = windowEndMin - windowStartMin;
    const slotsPerDay = Math.floor(windowMinutes / duration) * concurrency;
    const daysNeeded = Math.ceil(totalBunks / slotsPerDay);
    const actualDays = getDatesBetween(result.startDate, result.endDate).length;

    const alertFn = typeof window.daShowAlert === 'function' ? window.daShowAlert : alert;
    alertFn(
        '✅ Created "' + result.name + '"<br><br>' +
        '📊 <strong>' + totalBunks + ' bunks</strong>, ~' + slotsPerDay + '/day capacity<br>' +
        '📅 ' + actualDays + ' day' + (actualDays > 1 ? 's' : '') + ' available' +
        (daysNeeded > actualDays ? '<br><br>⚠️ May need ' + daysNeeded + ' days to finish all bunks — consider extending the date range.' : '')
    );
}

async function showEditEventModal(evt, containerEl) {
    const g = window.loadGlobalSettings?.() || {};
    const allFields = (g.app1?.fields || []).map(f => f.name).sort();

    const showModal = typeof window.daShowModal === 'function' ? window.daShowModal : null;
    if (!showModal) return;

    const result = await showModal({
        title: 'Edit: ' + evt.name,
        wide: true,
        fields: [
            { name: 'name', label: 'Event Name', type: 'text', default: evt.name },
            { name: 'startDate', label: 'Start Date', type: 'text', default: evt.dateRange.start },
            { name: 'endDate', label: 'End Date', type: 'text', default: evt.dateRange.end },
            { name: 'windowStart', label: 'Daily Window Start', type: 'text', default: minutesToTime(evt.dailyWindow.startMin) },
            { name: 'windowEnd', label: 'Daily Window End', type: 'text', default: minutesToTime(evt.dailyWindow.endMin) },
            { name: 'duration', label: 'Duration Per Bunk (minutes)', type: 'text', default: String(evt.durationPerBunk) },
            { name: 'concurrency', label: 'Bunks at a Time', type: 'text', default: String(evt.concurrency || 2) },
            { name: 'location', label: 'Location (optional)', type: 'select', default: evt.location || '', options: [{ value: '', label: '-- None --' }, ...allFields.map(f => ({ value: f, label: f }))] }
        ],
        confirmText: 'Save Changes'
    });

    if (!result) return;

    const windowStartMin = parseTimeToMinutes(result.windowStart);
    const windowEndMin = parseTimeToMinutes(result.windowEnd);
    if (windowStartMin == null || windowEndMin == null || windowEndMin <= windowStartMin) {
        (typeof window.daShowAlert === 'function' ? window.daShowAlert : alert)('Invalid time window.');
        return;
    }

    updateEvent(evt.id, {
        name: (result.name || evt.name).trim(),
        dateRange: { start: result.startDate || evt.dateRange.start, end: result.endDate || evt.dateRange.end },
        dailyWindow: { startMin: windowStartMin, endMin: windowEndMin },
        durationPerBunk: parseInt(result.duration) || evt.durationPerBunk,
        concurrency: Math.max(1, parseInt(result.concurrency) || evt.concurrency),
        location: result.location || null
    });

    renderRotationEventsPane(containerEl);
}

// =================================================================
// INTEGRATION: Hook into Daily Adjustments subtab system
// =================================================================

function injectSubtab() {
    // ★ Only available in auto builder mode
    if (window._daBuilderMode !== 'auto') {
        removeSubtab();
        return false;
    }

    // Find the subtabs container
    const subtabsBar = document.querySelector('.da-subtabs, .ms-container .da-subtabs');
    if (!subtabsBar) return false;

    // Don't double-inject
    if (subtabsBar.querySelector('[data-tab="rotation-events"]')) return true;

    // Add the subtab button
    const tab = document.createElement('button');
    tab.className = 'da-subtab';
    tab.dataset.tab = 'rotation-events';
    tab.textContent = 'Rotation Events';

    // Insert before the last tab
    const tabs = subtabsBar.querySelectorAll('.da-subtab');
    if (tabs.length > 0) {
        subtabsBar.appendChild(tab);
    } else {
        subtabsBar.appendChild(tab);
    }

    // Add the pane
    const panesParent = subtabsBar.parentElement;
    let pane = panesParent.querySelector('#da-pane-rotation-events');
    if (!pane) {
        pane = document.createElement('div');
        pane.id = 'da-pane-rotation-events';
        pane.className = 'da-pane';
        pane.innerHTML = '<div id="da-rotation-events-container"></div>';
        panesParent.appendChild(pane);
    }

    // Hook tab click
    tab.onclick = () => {
        subtabsBar.querySelectorAll('.da-subtab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        panesParent.querySelectorAll('.da-pane').forEach(p => p.classList.remove('active'));
        pane.classList.add('active');

        const container = pane.querySelector('#da-rotation-events-container');
        renderRotationEventsPane(container);
    };

    // Add badge if there are active events for today
    updateTabBadge();

    return true;
}

function updateTabBadge() {
    const dateKey = window.currentScheduleDate || new Date().toISOString().split('T')[0];
    const events = loadRotationEvents();
    const activeCount = events.filter(e => isDateInRange(dateKey, e.dateRange.start, e.dateRange.end)).length;

    const tab = document.querySelector('.da-subtab[data-tab="rotation-events"]');
    if (!tab) return;

    // Remove existing badge
    const existingBadge = tab.querySelector('.re-badge');
    if (existingBadge) existingBadge.remove();

    if (activeCount > 0) {
        const badge = document.createElement('span');
        badge.className = 're-badge';
        badge.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; padding:0 4px; border-radius:8px; background:#F59E0B; color:#fff; font-size:10px; font-weight:700; margin-left:6px;';
        badge.textContent = activeCount;
        tab.appendChild(badge);
    }
}

// =================================================================
// INTEGRATION: Hook into auto-scheduler
// =================================================================

/**
 * Called from scheduler_core_auto.js to get rotation event data for the current date.
 * Returns the scheduling function reference.
 */
function getSchedulerHook() {
    return {
        getAssignmentsForDate,
        writeBlocksToTimelines,
        markCompleted,
        hasActiveEvents: function (dateKey) {
            const events = loadRotationEvents();
            return events.some(e => isDateInRange(dateKey, e.dateRange.start, e.dateRange.end));
        }
    };
}

// =================================================================
// INIT
// =================================================================

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function removeSubtab() {
    const tab = document.querySelector('.da-subtab[data-tab="rotation-events"]');
    if (tab) tab.remove();
    const pane = document.querySelector('#da-pane-rotation-events');
    if (pane) pane.remove();
}

function init() {
    // Try to inject subtab immediately (will no-op if not auto mode)
    if (!injectSubtab()) {
        // Retry after DA renders
        const observer = new MutationObserver(() => {
            if (injectSubtab()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // Safety timeout
        setTimeout(() => observer.disconnect(), 15000);
    }

    // ★ Listen for builder mode changes — inject/remove subtab accordingly
    window.addEventListener('campistry-builder-mode-changed', (e) => {
        const newMode = e.detail?.mode;
        if (newMode === 'auto') {
            setTimeout(() => injectSubtab(), 400);
        } else {
            removeSubtab();
        }
    });

    // Listen for date changes to update badge
    window.addEventListener('campistry-date-changed', () => {
        updateTabBadge();
        // Re-render if pane is active
        const pane = document.querySelector('#da-pane-rotation-events.active');
        if (pane) {
            const container = pane.querySelector('#da-rotation-events-container');
            if (container) renderRotationEventsPane(container);
        }
    });

    // Listen for tab switches to DA
    const origShowTab = window.showTab;
    if (origShowTab && !window._rotationEventsTabHooked) {
        window._rotationEventsTabHooked = true;
        window.showTab = function (tabId) {
            origShowTab(tabId);
            if (tabId === 'daily-adjustments' && window._daBuilderMode === 'auto') {
                setTimeout(() => {
                    injectSubtab();
                    updateTabBadge();
                }, 300);
            }
        };
    }
}


// =================================================================
// SCHEDULER NEEDS API — for greedyPackBunk integration
// =================================================================

/**
 * Returns an array of need objects for a specific bunk on a specific date.
 * Each active rotation event the bunk is eligible for (not excluded, not yet
 * completed) produces one need shaped like the swim/snack needs the packer
 * already consumes. The packer will fit them into available gaps inside the
 * event's daily window with the exact specified duration.
 *
 * Called from scheduler_core_auto.js → greedyPackBunk during needs assembly.
 */
function getNeedsForBunk(bunkName, dateKey) {
    if (!bunkName || !dateKey) return [];
    const events = loadRotationEvents();
    if (!events.length) return [];

    const bunkStr = String(bunkName);
    const needs = [];

    events.forEach(evt => {
        if (!isDateInRange(dateKey, evt.dateRange.start, evt.dateRange.end)) return;

        // Excluded?
        if (Array.isArray(evt.excludedBunks) && evt.excludedBunks.includes(bunkStr)) return;

        // Already completed (any day in the range)?
        const completed = getCompletedBunks(evt);
        if (completed.has(bunkStr)) return;

        const dur = parseInt(evt.durationPerBunk) || 0;
        if (dur <= 0) return;
        const winStart = evt.dailyWindow?.startMin;
        const winEnd = evt.dailyWindow?.endMin;
        if (winStart == null || winEnd == null || winEnd - winStart < dur) return;

        needs.push({
            type: 'rotation_event',
            event: evt.name,
            layer: {
                type: 'rotation_event',
                event: evt.name,
                startMin: winStart,
                endMin: winEnd,
                durationMin: dur,
                durationMax: dur,
                periodMin: dur,
                _rotationEventId: evt.id
            },
            dMin: dur,
            dMax: dur,
            windowStart: winStart,
            windowEnd: winEnd,
            _activityLocked: true,
            _source: 'rotation_event',
            _rotationEventId: evt.id,
            _rotationEventConcurrency: parseInt(evt.concurrency) || 1,
            _rotationEventColor: evt.color || '#F59E0B',
            _rotationEventLocation: evt.location || null
        });
    });

    return needs;
}

/**
 * Compute daily quotas for each active rotation event on this date.
 * Returns { [eventId]: { eventId, eventName, remainingCount, remainingBunks (Set),
 *           daysLeft, dailyTarget, isLastDay, placed (mutable counter) } }
 * The scheduler increments `placed` as bunks are successfully scheduled.
 */
function getRotationQuotas(dateKey) {
    if (!dateKey) return {};
    const events = loadRotationEvents();
    const quotas = {};
    events.forEach(evt => {
        if (!isDateInRange(dateKey, evt.dateRange.start, evt.dateRange.end)) return;
        const remaining = getRemainingBunks(evt);
        if (remaining.length === 0) return;
        const allDates = getDatesBetween(evt.dateRange.start, evt.dateRange.end);
        const todayIdx = allDates.indexOf(dateKey);
        if (todayIdx < 0) return;
        const daysLeft = allDates.length - todayIdx; // includes today
        const isLastDay = daysLeft <= 1;
        // Front-load: try 1.6× the even split on early days so later days are lighter
        // e.g., 38 bunks / 3 days: day1 target=21, day2=15, day3=remaining 2
        const evenTarget = Math.ceil(remaining.length / daysLeft);
        const dailyTarget = isLastDay ? remaining.length : Math.min(remaining.length, Math.ceil(evenTarget * 1.6));
        quotas[evt.id] = {
            eventId: evt.id,
            eventName: evt.name,
            remainingCount: remaining.length,
            remainingBunks: new Set(remaining.map(b => b.bunk)),
            daysLeft: daysLeft,
            dailyTarget: dailyTarget,
            isLastDay: isLastDay,
            placed: 0
        };
    });
    return quotas;
}

/**
 * Walk a finalized scheduleAssignments object and mark every bunk that
 * received a rotation event block as completed for the given date.
 * Called from scheduler_core_auto.js after the build finishes.
 */
function markCompletionsFromSchedule(dateKey, scheduleAssignments) {
    if (!dateKey || !scheduleAssignments) return { marked: 0 };
    const events = loadRotationEvents();
    if (!events.length) return { marked: 0 };

    // Build event-name → eventId map for fast lookup
    const nameToId = {};
    events.forEach(e => { if (e.name) nameToId[e.name] = e.id; });

    // Group bunks by eventId
    const byEvent = {}; // { eventId: Set<bunkName> }
    Object.entries(scheduleAssignments).forEach(([bunk, slots]) => {
        if (!Array.isArray(slots)) return;
        slots.forEach(entry => {
            if (!entry || entry.continuation) return;
            // Match by explicit marker first, fall back to activity name
            const eid = entry._rotationEventId || nameToId[entry._activity];
            if (!eid) return;
            if (!byEvent[eid]) byEvent[eid] = new Set();
            byEvent[eid].add(String(bunk));
        });
    });

    let marked = 0;
    Object.entries(byEvent).forEach(([eid, bunkSet]) => {
        const bunks = Array.from(bunkSet);
        markCompleted(eid, dateKey, bunks);
        marked += bunks.length;
    });

    return { marked };
}

// =================================================================
// EXPORTS
// =================================================================

const RotationEvents = {
    loadRotationEvents,
    saveRotationEvents,
    getAssignmentsForDate,
    writeBlocksToTimelines,
    markCompleted,
    getSchedulerHook,
    getRemainingBunks,
    getCompletedBunks,
    getNeedsForBunk,
    getRotationQuotas,
    markCompletionsFromSchedule,
    renderRotationEventsPane,
    injectSubtab,
    removeSubtab,
    updateTabBadge,
    init
};
window.RotationEvents = RotationEvents;

// Auto-init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600));
} else {
    setTimeout(init, 600);
}

console.log('[ROTATION_EVENTS] Module v1.0 loaded');

})();
