// ============================================================================
// auto_fill_slot.js  — Smart single-slot auto-filler for the post-edit grid
// ============================================================================
// When the auto-builder leaves a Free slot, or when a user clears a cell,
// clicking "Auto Fill" on that cell runs a mini-generation just for that
// bunk: checks field availability, grade constraints, rotation history,
// daily limits, and recency penalties, then writes the best candidate.
// ============================================================================

(function () {
    'use strict';

    // ========================================================================
    // HELPERS — fall back to locally-computed values when SDK utils are absent
    // ========================================================================

    function getDivision(bunk) {
        if (window.SchedulerCoreUtils?.getDivisionForBunk) return window.SchedulerCoreUtils.getDivisionForBunk(bunk);
        const divs = window.divisions || {};
        for (const [divName, d] of Object.entries(divs)) {
            if (d.bunks?.includes(bunk)) return divName;
        }
        return null;
    }

    function getSlotInfo(divName, slotIdx, bunk) {
        const dt = window.divisionTimes?.[divName];
        if (!dt) return null;
        // Handle per-bunk slot overrides (auto-mode)
        if (dt._isPerBunk && dt._perBunkSlots) {
            const perBunk = dt._perBunkSlots[String(bunk)];
            if (perBunk?.[slotIdx]) return perBunk[slotIdx];
        }
        return dt[slotIdx] || null;
    }

    function getGlobalSettings() {
        return window.loadGlobalSettings?.() || {};
    }

    function isFreeEntry(entry) {
        return !entry || entry.field === 'Free' || entry._activity === 'Free' || (!entry.field && !entry._activity);
    }

    function toast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        const id = 'afs-toast';
        document.getElementById(id)?.remove();
        const el = document.createElement('div');
        el.id = id;
        const bg = type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#dc2626';
        el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;background:${bg};color:#fff;
            padding:10px 18px;border-radius:8px;font-size:0.84rem;font-weight:600;
            box-shadow:0 4px 16px rgba(0,0,0,0.22);pointer-events:none;`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3800);
    }

    // ========================================================================
    // BUILD ACTIVITY PROPERTIES MAP
    // Prefer window.activityProperties; fall back to parsing global settings.
    // ========================================================================

    function getActivityProperties() {
        if (window.activityProperties && Object.keys(window.activityProperties).length) {
            return window.activityProperties;
        }
        // Build from global settings
        const gs = getGlobalSettings();
        const map = {};
        (gs.app1?.fields || []).forEach(f => {
            map[f.name] = {
                name: f.name,
                type: 'field',
                activities: f.activities || [],
                sharableWith: f.sharableWith || f.sharing || { type: 'not_sharable', capacity: 1 },
                maxUsage: f.maxUsage || 0,
            };
        });
        (gs.app1?.specialActivities || []).forEach(s => {
            const loc = s.location || s.name;
            map[loc] = map[loc] || {
                name: loc,
                type: 'special',
                activities: [s.name],
                sharableWith: { type: 'not_sharable', capacity: 1 },
                maxUsage: s.maxUsage || 0,
            };
        });
        return map;
    }

    // ========================================================================
    // FIELD AVAILABILITY CHECK
    // Scans scheduleAssignments for all bunks whose time overlaps our slot,
    // applies sharing/capacity rules, returns true if field has room.
    // ========================================================================

    function isFieldAvailable(fieldName, myBunk, myDiv, slotStart, slotEnd, actProps) {
        const ap = actProps[fieldName] || {};
        const sharing = ap.sharableWith || ap.sharing || {};
        const sharingType = sharing.type || 'not_sharable';
        const capacity = (sharingType === 'not_sharable') ? 1 : (sharing.capacity || 1);

        let usageCount = 0;
        const sa = window.scheduleAssignments || {};
        const dt = window.divisionTimes || {};

        for (const [otherBunk, slots] of Object.entries(sa)) {
            if (!Array.isArray(slots) || otherBunk === myBunk) continue;
            const otherDiv = getDivision(otherBunk);
            const otherSlots = dt[otherDiv] || [];

            for (let i = 0; i < slots.length; i++) {
                const ot = otherSlots[i];
                if (!ot) continue;
                const otStart = ot.startMin ?? 0;
                const otEnd   = ot.endMin   ?? 0;
                // Time overlap test
                if (otEnd <= slotStart || otStart >= slotEnd) continue;

                const oe = slots[i];
                if (isFreeEntry(oe)) continue;

                // Extract field name from entry
                let usedField = oe._location || '';
                if (!usedField && oe.field && oe.field !== 'Free') {
                    usedField = oe.field.includes(' – ') ? oe.field.split(' – ')[0].trim()
                              : oe.field.includes(' - ') ? oe.field.split(' - ')[0].trim()
                              : oe.field;
                }
                if (usedField !== fieldName) continue;

                // Apply sharing rules
                if (sharingType === 'not_sharable') return false;
                if (sharingType === 'same_division' && otherDiv !== myDiv) return false;
                if (sharingType === 'custom') {
                    const allowed = sharing.divisions || [];
                    if (!allowed.includes(myDiv) || !allowed.includes(otherDiv)) return false;
                }
                usageCount++;
                if (usageCount >= capacity) return false;
            }
        }
        return true;
    }

    // ========================================================================
    // BUILD CANDIDATE LIST
    // Returns all activities that are physically available for the slot.
    // ========================================================================

    function buildCandidates(bunk, slotStart, slotEnd, divName, actProps) {
        const gs = getGlobalSettings();
        const candidates = [];

        // Sports / field activities
        (gs.app1?.fields || []).forEach(f => {
            if (!isFieldAvailable(f.name, bunk, divName, slotStart, slotEnd, actProps)) return;
            (f.activities || []).forEach(actName => {
                candidates.push({ activity: actName, field: f.name, type: 'sport', maxUsage: f.maxUsage || 0 });
            });
        });

        // Special activities
        (gs.app1?.specialActivities || []).forEach(s => {
            const loc = s.location || null;
            if (loc && !isFieldAvailable(loc, bunk, divName, slotStart, slotEnd, actProps)) return;
            candidates.push({ activity: s.name, field: loc, type: 'special', maxUsage: s.maxUsage || 0 });
        });

        return candidates;
    }

    // ========================================================================
    // ROTATION HISTORY — compute from allDaily + rotationHistory
    // ========================================================================

    function buildHistory(bunk, today) {
        const allDaily = window.loadAllDailyData?.() || {};
        const countsByAct = {};
        const lastDoneByAct = {};
        const todayActs = new Set();

        // Live slots for TODAY from window.scheduleAssignments
        (window.scheduleAssignments?.[bunk] || []).forEach(e => {
            if (!e || e.continuation || e._isTransition) return;
            const a = e._activity || e.activity || e.sport || '';
            if (a && a !== 'Free' && !a.toLowerCase().includes('transition')) todayActs.add(a);
        });

        // Historical data (skip today — we use live data above)
        Object.keys(allDaily).sort().forEach(dateKey => {
            if (dateKey === today) return;
            const sched = allDaily[dateKey]?.scheduleAssignments?.[bunk] || [];
            sched.forEach(e => {
                if (!e || e.continuation || e._isTransition) return;
                const a = e._activity || e.activity || e.sport || '';
                if (!a || a === 'Free' || a.toLowerCase().includes('transition')) return;
                countsByAct[a] = (countsByAct[a] || 0) + 1;
                if (!lastDoneByAct[a] || dateKey > lastDoneByAct[a]) lastDoneByAct[a] = dateKey;
            });
        });

        // Rotation history store (supplements allDaily)
        const rotHist = window.loadRotationHistory?.() || { bunks: {} };
        const bh = rotHist.bunks?.[bunk] || {};
        Object.keys(bh).forEach(act => {
            try {
                const d = new Date(bh[act]).toISOString().split('T')[0];
                if (!lastDoneByAct[act] || d > lastDoneByAct[act]) lastDoneByAct[act] = d;
            } catch (_) {}
        });

        return { countsByAct, lastDoneByAct, todayActs };
    }

    // ========================================================================
    // SCORE & PICK — lower score = better candidate
    // ========================================================================

    function scoreAndPick(bunk, candidates, today) {
        const { countsByAct, lastDoneByAct, todayActs } = buildHistory(bunk, today);

        const scored = candidates.map(c => {
            const act = c.activity;

            // ── HARD DISQUALIFIERS ──────────────────────────────────────────
            if (todayActs.has(act)) return null;     // already doing it today
            if (c.maxUsage > 0 && (countsByAct[act] || 0) >= c.maxUsage) return null; // at limit

            // ── SCORING ─────────────────────────────────────────────────────
            let score = 0;
            const count = countsByAct[act] || 0;

            if (count === 0) score -= 5000;           // never done — strong bonus
            else if (count === 1) score -= 2000;
            else if (count === 2) score -= 500;

            const last = lastDoneByAct[act];
            if (last) {
                const diff = Math.round((new Date(today) - new Date(last)) / 86_400_000);
                if (diff === 1) score += 9000;        // yesterday — heavy penalty
                else if (diff === 2) score += 5000;
                else if (diff === 3) score += 2500;
                else if (diff >= 7) score -= 2000;    // long time ago — bonus
            }

            // Small random tie-breaker so repeated calls vary
            score += Math.random() * 50;

            return { ...c, score, count, last };
        }).filter(Boolean);

        if (!scored.length) return null;
        scored.sort((a, b) => a.score - b.score);
        return scored[0];
    }

    // ========================================================================
    // WRITE THE FILL
    // ========================================================================

    function writeFill(bunk, slotIdx, pick) {
        // ★ RBAC: verify the user can edit this bunk before writing
        if (!window.AccessControl?.canEditBunk?.(bunk)) {
            console.warn('[AutoFill] writeFill blocked — no edit access to bunk:', bunk);
            return;
        }
        if (typeof window.applyDirectEdit === 'function') {
            window.applyDirectEdit(bunk, [slotIdx], pick.activity, pick.field || null, false);
        } else {
            if (!window.scheduleAssignments)       window.scheduleAssignments = {};
            if (!window.scheduleAssignments[bunk]) window.scheduleAssignments[bunk] = [];
            const fieldVal = pick.field ? `${pick.field} – ${pick.activity}` : pick.activity;
            window.scheduleAssignments[bunk][slotIdx] = {
                field: fieldVal,
                sport: pick.activity,
                _activity: pick.activity,
                _location: pick.field || null,
                continuation: false,
                _fixed: true,
                _postEdit: true,
                _autoFilled: true,
                _editedAt: Date.now(),
            };
        }
    }

    // ========================================================================
    // MAIN ENTRY POINT
    // ========================================================================

    async function autoFillSlot(bunk, slotIdx) {
        // ★ RBAC: check division access before doing any work
        const _divCheck = getDivision(bunk);
        if (_divCheck && !window.AccessControl?.canEditDivision?.(_divCheck)) {
            window.AccessControl?.showPermissionDenied?.(`auto-fill ${_divCheck}`);
            return;
        }

        // 1. Resolve division + slot time
        const divName = getDivision(bunk);
        if (!divName) { toast('Cannot find division for ' + bunk, 'error'); return; }

        const slot = getSlotInfo(divName, slotIdx, bunk);
        if (!slot) { toast('No time info for slot ' + slotIdx, 'error'); return; }

        const slotStart = slot.startMin;
        const slotEnd   = slot.endMin;

        // 2. Confirm slot is free and not locked
        const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
        if (entry && entry._fixed && entry._pinned) {
            toast('This slot is pinned and cannot be auto-filled', 'warning');
            return;
        }
        if (entry && !isFreeEntry(entry) && entry._fixed) {
            toast('This slot is locked — clear it first before auto-filling', 'warning');
            return;
        }

        // 3. Build candidates
        const actProps = getActivityProperties();
        const candidates = buildCandidates(bunk, slotStart, slotEnd, divName, actProps);
        if (!candidates.length) { toast('No available activities found for this slot', 'warning'); return; }

        // 4. Score and pick
        const today = window.currentScheduleDate || new Date().toLocaleDateString('en-CA');
        const best = scoreAndPick(bunk, candidates, today);
        if (!best) { toast('All candidates disqualified by constraints — nothing to fill', 'warning'); return; }

        // 5. Write + save + refresh
        writeFill(bunk, slotIdx, best);

        if (typeof window.bypassSaveAllBunks === 'function') {
            await window.bypassSaveAllBunks([bunk]);
        } else {
            window.saveSchedule?.();
        }

        window.updateTable?.();

        const where = best.field ? ` @ ${best.field}` : '';
        toast(`✓ Auto-filled: ${best.activity}${where}`, 'success');
    }

    // ========================================================================
    // UI — inject "Auto Fill" buttons into free cells
    // ========================================================================

    function injectButtons() {
        document.querySelectorAll('td[data-bunk][data-slot]').forEach(td => {
            const bunk    = td.dataset.bunk;
            const slotIdx = parseInt(td.dataset.slot, 10);
            if (!bunk || isNaN(slotIdx)) return;

            const entry = window.scheduleAssignments?.[bunk]?.[slotIdx];
            if (!isFreeEntry(entry)) return;

            if (td.querySelector('.afs-btn')) return; // already injected

            const btn = document.createElement('button');
            btn.className = 'afs-btn';
            btn.innerHTML = '⚡ Auto Fill';
            btn.title = 'Auto-fill this slot based on rotation history and field availability';
            btn.style.cssText = [
                'display:block', 'margin:5px auto 0', 'padding:3px 10px',
                'background:#1e40af', 'color:#fff', 'border:none', 'border-radius:999px',
                'font-size:0.68rem', 'font-weight:700', 'cursor:pointer',
                'letter-spacing:0.02em', 'opacity:0.82', 'transition:opacity 0.15s',
                'white-space:nowrap',
            ].join(';');

            btn.onmouseenter = () => { btn.style.opacity = '1'; };
            btn.onmouseleave = () => { btn.style.opacity = '0.82'; };

            btn.addEventListener('click', async e => {
                e.stopPropagation();
                e.preventDefault();
                btn.textContent = '…';
                btn.disabled = true;
                try {
                    await autoFillSlot(bunk, slotIdx);
                } catch (err) {
                    toast('Auto-fill error: ' + err.message, 'error');
                    console.error('[AutoFill]', err);
                }
                // Table re-render removes the button; nothing more needed
            });

            td.appendChild(btn);
        });
    }

    function setupInjection() {
        // Wrap updateTable
        const _origUpdate = window.updateTable;
        window.updateTable = function (...args) {
            const r = _origUpdate?.apply(this, args);
            setTimeout(injectButtons, 80);
            return r;
        };

        // Also wrap renderStaggeredView — daily_adjustments.js calls this directly
        const _origRender = window.renderStaggeredView;
        window.renderStaggeredView = function (...args) {
            const r = _origRender?.apply(this, args);
            setTimeout(injectButtons, 150);
            return r;
        };

        // MutationObserver as belt-and-suspenders
        const target = document.getElementById('scheduleTable') || document.body;
        const obs = new MutationObserver(() => {
            clearTimeout(obs._t);
            obs._t = setTimeout(injectButtons, 150);
        });
        obs.observe(target, { childList: true, subtree: true });

        // Initial injection — delay enough for the table to render
        setTimeout(injectButtons, 800);
    }

    // ========================================================================
    // EXPORTS + INIT
    // ========================================================================

    window.AutoFillSlot = { autoFillSlot, injectButtons };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupInjection);
    } else {
        setupInjection();
    }

})();
