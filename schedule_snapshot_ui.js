// =================================================================
// schedule_snapshot_ui.js — "Save Schedule" button + Saved Schedules table
// VERSION: v1.0
// -----------------------------------------------------------------
// Gives the unified Daily Schedule view a visible Save button and a
// table of previously-saved schedules that can be recalled with one
// click. Backed by the existing schedule_versions table via
// window.ScheduleVersionManager / window.ScheduleVersionsDB.
//
// Why this exists: people have accidentally wiped/overwritten a day's
// schedule with no easy way back. This lets them snapshot the current
// schedule and restore any earlier snapshot for the same date.
// =================================================================

(function () {
    'use strict';

    console.log('💾 Schedule Snapshot UI v1.0 loading...');

    const AUTO_BACKUP_PREFIX = 'Auto-backup before';

    function getDateKey() {
        return window.currentScheduleDate || new Date().toISOString().split('T')[0];
    }

    function vm() { return window.ScheduleVersionManager; }
    function db() { return window.ScheduleVersionsDB; }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // -------------------------------------------------------------
    // Lightweight toast (avoids blocking alert() for the happy path)
    // -------------------------------------------------------------
    function toast(message, kind = 'info') {
        let host = document.getElementById('snapshotToastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'snapshotToastHost';
            host.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:8px;align-items:center;';
            document.body.appendChild(host);
        }
        const bg = kind === 'error' ? '#c62828' : (kind === 'success' ? '#2e7d32' : '#147D91');
        const el = document.createElement('div');
        el.style.cssText = `background:${bg};color:#fff;padding:10px 18px;border-radius:6px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:80vw;`;
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 2600);
    }

    // -------------------------------------------------------------
    // Save the current live schedule as a named snapshot
    // -------------------------------------------------------------
    async function saveNow() {
        if (!vm()?.saveVersion) { toast('Save system not available yet.', 'error'); return; }
        if (!window.scheduleAssignments || Object.keys(window.scheduleAssignments).length === 0) {
            toast('There is no schedule to save for this date yet.', 'error');
            return;
        }
        const def = `Saved ${new Date().toLocaleString()}`;
        const name = (window.prompt('Name this saved schedule (so you can find it later):', def) || '').trim();
        if (!name) return; // cancelled
        // Warn before silently overwriting a snapshot with the same name.
        try {
            const existing = (await db()?.listVersions?.(getDateKey())) || [];
            if (existing.some(v => (v.name || '').toLowerCase() === name.toLowerCase())) {
                if (!window.confirm(`A saved schedule named “${name}” already exists. Overwrite it?`)) return;
            }
        } catch (_e) { /* listing is best-effort; proceed to save */ }
        setSaveState('saving');
        try {
            const res = await vm().saveVersion(name, { silent: true });
            if (res?.success) {
                setSaveState('saved');                       // button flips to "Saved!"
                toast(`Saved as “${name}”. Recall it anytime from the Saved button.`, 'success');
                if (document.getElementById('snapshotModalOverlay')) renderTable();
                setTimeout(() => setSaveState('idle'), 2000); // revert button label after a beat
            } else {
                setSaveState('idle');
                toast('Could not save: ' + (res?.error || 'unknown error'), 'error');
            }
        } catch (e) {
            setSaveState('idle');
            toast('Could not save: ' + e.message, 'error');
        }
    }

    // Find the live Save button(s) — the calendar-views toolbar (.scv-save-btn)
    // and the static fallback (#snapshotSaveBtn) — and the list button(s).
    function saveBtns() { return Array.from(document.querySelectorAll('.scv-save-btn, #snapshotSaveBtn')); }
    function listBtns() { return Array.from(document.querySelectorAll('.scv-saved-btn, #snapshotListBtn')); }

    // Drive the Save button through saving -> saved -> idle so it's obvious
    // something happened (the old code only toggled ids that didn't exist).
    function setSaveState(state) {
        saveBtns().forEach(b => {
            if (b.dataset.idleLabel == null) b.dataset.idleLabel = b.textContent;
            if (state === 'saving') {
                b.disabled = true; b.style.opacity = '0.75'; b.style.cursor = 'wait';
                b.textContent = 'Saving…';
            } else if (state === 'saved') {
                b.disabled = true; b.style.opacity = '1'; b.style.cursor = 'default';
                b.textContent = 'Saved!';
            } else {
                b.disabled = false; b.style.opacity = '1'; b.style.cursor = 'pointer';
                b.textContent = b.dataset.idleLabel;
            }
        });
        listBtns().forEach(b => {
            const busy = state === 'saving';
            b.disabled = busy; b.style.opacity = busy ? '0.75' : '1';
        });
    }

    function setButtonsBusy(busy) {
        const all = [...saveBtns(), ...listBtns()];
        const prev = all.map(b => b.disabled);
        all.forEach(b => { b.disabled = busy; b.style.opacity = busy ? '0.6' : '1'; });
        return () => all.forEach((b, i) => { b.disabled = prev[i]; b.style.opacity = '1'; });
    }

    // -------------------------------------------------------------
    // Modal with the saved-schedules table
    // -------------------------------------------------------------
    function openModal() {
        if (document.getElementById('snapshotModalOverlay')) { renderTable(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'snapshotModalOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px;';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;max-width:760px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3);overflow:hidden;';
        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #e0e0e0;">
                <h3 style="margin:0;font-size:18px;">Saved Schedules — <span id="snapshotModalDate" style="color:#147D91;"></span></h3>
                <button id="snapshotModalClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666;line-height:1;">&times;</button>
            </div>
            <div style="padding:10px 20px;border-bottom:1px solid #f0f0f0;color:#555;font-size:13px;">
                Restore a saved schedule to bring it back. Your current schedule is automatically backed up before any restore.
            </div>
            <div id="snapshotTableWrap" style="overflow:auto;padding:0 20px 16px;flex:1;"></div>
            <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #e0e0e0;">
                <button id="snapshotModalSave" style="background:#2e7d32;color:#fff;border:none;padding:9px 18px;border-radius:5px;font-weight:600;cursor:pointer;">💾 Save Current Schedule</button>
                <button id="snapshotModalDone" style="background:#eee;color:#333;border:none;padding:9px 18px;border-radius:5px;font-weight:600;cursor:pointer;">Close</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        document.getElementById('snapshotModalClose').onclick = closeModal;
        document.getElementById('snapshotModalDone').onclick = closeModal;
        document.getElementById('snapshotModalSave').onclick = saveNow;
        renderTable();
    }

    function closeModal() {
        const o = document.getElementById('snapshotModalOverlay');
        if (o) o.remove();
    }

    async function renderTable() {
        const wrap = document.getElementById('snapshotTableWrap');
        const dateLabel = document.getElementById('snapshotModalDate');
        if (!wrap) return;
        const dateKey = getDateKey();
        if (dateLabel) dateLabel.textContent = dateKey;
        wrap.innerHTML = '<div style="padding:24px;text-align:center;color:#888;">Loading saved schedules…</div>';

        if (!db()?.listVersions) { wrap.innerHTML = '<div style="padding:24px;text-align:center;color:#c62828;">Save system not available.</div>'; return; }

        let versions = [];
        try { versions = await db().listVersions(dateKey) || []; }
        catch (e) { wrap.innerHTML = `<div style="padding:24px;text-align:center;color:#c62828;">Error loading: ${esc(e.message)}</div>`; return; }

        if (!versions.length) {
            wrap.innerHTML = '<div style="padding:30px;text-align:center;color:#888;">No saved schedules for this date yet.<br>Use “Save Current Schedule” to create one.</div>';
            return;
        }

        const rows = versions.map(v => {
            const isAuto = (v.name || '').startsWith(AUTO_BACKUP_PREFIX);
            const when = v.created_at ? new Date(v.created_at).toLocaleString() : '—';
            const tag = isAuto
                ? '<span style="background:#fff3e0;color:#e65100;font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;margin-left:8px;">auto</span>'
                : '';
            return `
                <tr data-id="${esc(v.id)}" style="border-bottom:1px solid #f0f0f0;">
                    <td style="padding:10px 8px;vertical-align:middle;">${esc(v.name)}${tag}</td>
                    <td style="padding:10px 8px;vertical-align:middle;color:#666;white-space:nowrap;">${esc(when)}</td>
                    <td style="padding:10px 8px;vertical-align:middle;text-align:right;white-space:nowrap;">
                        <button class="snapshotRestoreBtn" data-id="${esc(v.id)}" data-name="${esc(v.name)}"
                            style="background:#147D91;color:#fff;border:none;padding:6px 14px;border-radius:4px;font-weight:600;cursor:pointer;margin-right:6px;">Restore</button>
                        <button class="snapshotDeleteBtn" data-id="${esc(v.id)}" data-name="${esc(v.name)}"
                            style="background:none;color:#c62828;border:1px solid #f0c0c0;padding:6px 12px;border-radius:4px;font-weight:600;cursor:pointer;">Delete</button>
                    </td>
                </tr>`;
        }).join('');

        wrap.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                    <tr style="text-align:left;color:#888;font-size:12px;text-transform:uppercase;">
                        <th style="padding:8px;border-bottom:2px solid #eee;">Name</th>
                        <th style="padding:8px;border-bottom:2px solid #eee;">Saved</th>
                        <th style="padding:8px;border-bottom:2px solid #eee;"></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        wrap.querySelectorAll('.snapshotRestoreBtn').forEach(b => b.onclick = () => doRestore(b.dataset.id, b.dataset.name));
        wrap.querySelectorAll('.snapshotDeleteBtn').forEach(b => b.onclick = () => doDelete(b.dataset.id, b.dataset.name));
    }

    async function doRestore(id, name) {
        if (!vm()?.restoreVersionById) { toast('Restore not available.', 'error'); return; }
        if (!window.confirm(`Restore “${name}”?\n\nThis replaces the current schedule for this date. Your current schedule is backed up first, so you can undo this.`)) return;
        const release = setButtonsBusy(true);
        try {
            const res = await vm().restoreVersionById(id);
            if (res?.success) {
                toast(`Restored “${name}”.`, 'success');
                closeModal();
            } else {
                toast('Could not restore: ' + (res?.error || 'unknown error'), 'error');
            }
        } catch (e) {
            toast('Could not restore: ' + e.message, 'error');
        } finally {
            release();
        }
    }

    async function doDelete(id, name) {
        if (!db()?.deleteVersion) { toast('Delete not available.', 'error'); return; }
        if (!window.confirm(`Delete saved schedule “${name}”? This cannot be undone.`)) return;
        try {
            const res = await db().deleteVersion(id);
            if (res?.success) { toast('Deleted.', 'success'); renderTable(); }
            else { toast('Could not delete: ' + (res?.error || 'unknown error'), 'error'); }
        } catch (e) {
            toast('Could not delete: ' + e.message, 'error');
        }
    }

    window.SnapshotUI = { saveNow, openModal, closeModal };

    console.log('💾 Schedule Snapshot UI v1.0 loaded');
})();
