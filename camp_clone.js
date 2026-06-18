/* ============================================================================
 * camp_clone.js — Platform super-admin "Debug Copy" tool
 *
 * Lets the platform owner clone ANY camp into a brand-new sandbox camp owned by
 * their own account, then switch into the copy and work on it freely. The
 * ORIGINAL camp is only ever READ — never written (the database forbids
 * super-admin writes to camps the user doesn't own; see migration 010).
 *
 * Think of it as a photocopier: original stays pristine, you scribble on the
 * copy.
 *
 * Requires migration 010_super_admin_debug_clone.sql to be applied, and the
 * current user to be listed in the super_admins table. If neither holds, the
 * panel never renders (and RLS blocks the reads regardless).
 *
 * Public API (window.CampClone):
 *   .isReady()            → boolean (super-admin + tables present)
 *   .listCamps()          → async [{id,name,owner,plan_status,...}]
 *   .cloneCamp(srcId,opts)→ async { copyId } — clones + switches into the copy
 *   .switchTo(campId)     → async — switch active camp (own camp or copy)
 *   .returnToMyCamp()     → async — clear selection, back to default camp
 *   .deleteCopy(campId)   → async — delete a "[COPY]" sandbox camp + its data
 * ========================================================================== */

(function () {
    'use strict';

    var DB = function () { return window.CampistryDB; };
    var sb = function () { return (DB() && DB().getClient && DB().getClient()) || window.supabase; };

    var PAGE = 1000;   // Supabase max rows per select
    var CHUNK = 500;   // rows per insert batch
    var _isSuperAdmin = false;

    function log() {
        try { console.log.apply(console, ['🧬 [CampClone]'].concat([].slice.call(arguments))); } catch (_) {}
    }

    // ─── Generic paginated read of every row for a camp ──────────────────────
    async function fetchAll(table, campId, orderCol) {
        var out = [];
        var from = 0;
        for (;;) {
            var q = sb().from(table).select('*').eq('camp_id', campId).range(from, from + PAGE - 1);
            if (orderCol) q = q.order(orderCol, { ascending: true });
            var res = await q;
            if (res.error) throw res.error;
            var rows = res.data || [];
            out = out.concat(rows);
            if (rows.length < PAGE) break;
            from += PAGE;
        }
        return out;
    }

    // ─── Chunked insert ──────────────────────────────────────────────────────
    async function insertChunked(table, rows) {
        for (var i = 0; i < rows.length; i += CHUNK) {
            var batch = rows.slice(i, i + CHUNK);
            var res = await sb().from(table).insert(batch);
            if (res.error) throw res.error;
        }
    }

    // ─── Super-admin gate ─────────────────────────────────────────────────────
    async function detectSuperAdmin() {
        try {
            if (DB() && DB().checkSuperAdmin) {
                _isSuperAdmin = await DB().checkSuperAdmin();
            }
        } catch (_) { _isSuperAdmin = false; }
        return _isSuperAdmin;
    }

    function isReady() { return _isSuperAdmin; }

    // ─── List every camp (super-admin SELECT) ────────────────────────────────
    async function listCamps() {
        var res = await sb().from('camps').select('*').order('name', { ascending: true });
        if (res.error) throw res.error;
        return res.data || [];
    }

    // ─── Clone a camp into a new sandbox camp owned by the current user ───────
    // opts.onProgress(msg) optional. Returns { copyId }.
    async function cloneCamp(sourceId, opts) {
        opts = opts || {};
        var progress = opts.onProgress || function () {};
        var userId = DB().getUserId();
        if (!userId) throw new Error('Not authenticated.');
        if (!sourceId) throw new Error('No source camp selected.');

        // Resolve source name for a friendly copy label.
        var srcName = opts.sourceName || null;
        if (!srcName) {
            var sres = await sb().from('camps').select('name').eq('id', sourceId).maybeSingle();
            srcName = (sres.data && sres.data.name) || 'Camp';
        }
        var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        var copyName = '[COPY] ' + srcName + ' — ' + stamp;

        // 1. READ everything from the source first (super-admin SELECT works
        //    regardless of which camp is active). Doing all reads up front means
        //    a read failure never leaves a half-created copy behind, and the
        //    window in which our active camp points at the copy is minimal.
        progress('Reading source camp…');
        var kv = await fetchAll('camp_state_kv', sourceId);
        var sched = await fetchAll('daily_schedules', sourceId);
        var rot = await fetchAll('rotation_counts', sourceId);
        log('Read source:', { kv: kv.length, sched: sched.length, rot: rot.length });

        // 2. Create the sandbox camp (owned by me).
        //    The camps table has an INSERT trigger that rejects camps without a
        //    valid plan ("an access code is required…"). A debug copy is an
        //    internal sandbox, so stamp it as a non-expiring active camp.
        progress('Creating sandbox camp…');
        var cres = await sb().from('camps')
            .insert([{
                owner: userId,
                name: copyName,
                address: '',
                plan_status: 'active',
                trial_started_at: null,
                trial_hours: null
            }])
            .select()
            .single();
        if (cres.error) throw cres.error;
        var copyId = cres.data.id;
        log('Created copy camp', copyId, copyName);

        // 3. Switch our active camp to the copy so RLS scopes writes to it.
        progress('Switching into the copy…');
        await DB().setActiveCamp(copyId);

        // 4. Write the copies, stamping the new camp_id onto each row.
        progress('Copying camp configuration…');
        var kvRows = kv.map(function (r) {
            return { camp_id: copyId, key: r.key, value: r.value, updated_at: new Date().toISOString() };
        });
        await insertChunked('camp_state_kv', kvRows);

        progress('Copying daily schedules…');
        var schedRows = sched.map(function (r) {
            var row = Object.assign({}, r);
            delete row.id;                 // let the DB mint a fresh surrogate key
            row.camp_id = copyId;
            row.updated_at = new Date().toISOString();
            return row;
        });
        await insertChunked('daily_schedules', schedRows);

        progress('Copying rotation history…');
        var rotRows = rot.map(function (r) {
            return {
                camp_id: copyId, date_key: r.date_key, bunk: r.bunk,
                activity: r.activity, count: r.count, updated_at: new Date().toISOString()
            };
        });
        await insertChunked('rotation_counts', rotRows);

        progress('Done.');
        return {
            copyId: copyId,
            copyName: copyName,
            counts: { config: kvRows.length, schedules: schedRows.length, rotation: rotRows.length }
        };
    }

    // ─── Switch / return ──────────────────────────────────────────────────────
    async function switchTo(campId) {
        await DB().setActiveCamp(campId);
    }
    async function returnToMyCamp() {
        await DB().clearActiveCamp();
    }

    // ─── Delete a sandbox copy (and only a sandbox copy) ──────────────────────
    async function deleteCopy(campId) {
        var userId = DB().getUserId();
        if (!campId || campId === userId) throw new Error('Refusing to delete your real camp.');
        // Verify it is a copy we own.
        var cres = await sb().from('camps').select('id,name,owner').eq('id', campId).maybeSingle();
        var camp = cres.data;
        if (!camp || camp.owner !== userId) throw new Error('Not a camp you own.');
        if (String(camp.name || '').indexOf('[COPY]') !== 0) {
            throw new Error('Only [COPY] sandbox camps can be deleted here.');
        }
        // Scope to the copy so RLS allows deleting its rows.
        await DB().setActiveCamp(campId);
        await sb().from('rotation_counts').delete().eq('camp_id', campId);
        await sb().from('daily_schedules').delete().eq('camp_id', campId);
        await sb().from('camp_state_kv').delete().eq('camp_id', campId);
        var del = await sb().from('camps').delete().eq('id', campId);
        // Whether or not the camps-row delete is permitted by RLS, leave the copy.
        await DB().clearActiveCamp();
        if (del.error) {
            throw new Error('Data cleared, but camp row could not be deleted: ' + del.error.message);
        }
    }

    window.CampClone = {
        isReady: isReady,
        listCamps: listCamps,
        cloneCamp: cloneCamp,
        switchTo: switchTo,
        returnToMyCamp: returnToMyCamp,
        deleteCopy: deleteCopy
    };

    // ─── UI: render the panel once we know the user is a super-admin ──────────
    function mountWhenReady() {
        var attach = function () {
            detectSuperAdmin().then(function (ok) {
                if (ok) renderPanel();
            });
        };
        if (DB() && DB().ready && typeof DB().ready.then === 'function') {
            DB().ready.then(attach);
        } else {
            window.addEventListener('campistry-db-ready', attach, { once: true });
            // Fallback in case the event already fired.
            setTimeout(attach, 1500);
        }
    }

    function el(tag, attrs, html) {
        var e = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
        if (html != null) e.innerHTML = html;
        return e;
    }

    function renderPanel() {
        if (document.getElementById('debug-copy-section')) return;

        var userId = DB().getUserId();
        var activeCampId = DB().getCampId();

        var section = el('section', {
            id: 'debug-copy-section',
            class: 'dashboard-section'
        });
        section.innerHTML =
            '<div class="dashboard-card" style="border:1px solid var(--slate-200);">' +
              '<div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
                '<h2 style="margin:0;">🧬 Debug Copy <span style="font-size:0.7rem;font-weight:600;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:999px;vertical-align:middle;">SUPER-ADMIN</span></h2>' +
                '<button type="button" id="dcRefreshBtn" class="btn-secondary" style="padding:6px 12px;font-size:0.8rem;">Refresh list</button>' +
              '</div>' +
              '<p style="font-size:0.85rem;color:var(--slate-500);margin:6px 0 14px;line-height:1.5;">' +
                'Make a full, isolated copy of any camp onto your own account. The original is only read — never changed. ' +
                'After copying you are switched into the copy and can edit / generate freely.' +
              '</p>' +
              '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">' +
                '<input type="text" id="dcSearch" placeholder="Filter camps…" ' +
                  'style="flex:1;min-width:180px;padding:8px 10px;border-radius:8px;border:1px solid var(--slate-200);font-size:0.85rem;">' +
                '<button type="button" id="dcReturnBtn" class="btn-secondary" style="padding:8px 14px;font-size:0.82rem;">↩ Return to my camp</button>' +
              '</div>' +
              '<div id="dcStatus" style="font-size:0.82rem;color:var(--slate-500);margin-bottom:10px;"></div>' +
              '<div id="dcList" style="display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto;"></div>' +
            '</div>';

        var anchor = document.getElementById('camp-dates-section') ||
                     document.getElementById('team-access-section');
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(section, anchor);
        } else {
            (document.querySelector('main') || document.body).appendChild(section);
        }

        var statusEl = section.querySelector('#dcStatus');
        var listEl = section.querySelector('#dcList');
        var searchEl = section.querySelector('#dcSearch');
        var allCamps = [];

        function setStatus(msg, isErr) {
            statusEl.textContent = msg || '';
            statusEl.style.color = isErr ? '#dc2626' : 'var(--slate-500)';
        }

        function draw() {
            var term = (searchEl.value || '').toLowerCase();
            listEl.innerHTML = '';
            allCamps
                .filter(function (c) {
                    return !term || (String(c.name || '').toLowerCase().indexOf(term) >= 0) ||
                                    (String(c.id || '').toLowerCase().indexOf(term) >= 0);
                })
                .forEach(function (c) {
                    var isActive = c.id === activeCampId;
                    var isMine = c.owner === userId;
                    var isCopy = String(c.name || '').indexOf('[COPY]') === 0;
                    var row = el('div', null);
                    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid ' +
                        (isActive ? '#10b981' : 'var(--slate-200)') + ';border-radius:10px;background:' +
                        (isActive ? '#ecfdf5' : '#fff') + ';';
                    var label = (c.name || '(unnamed)');
                    var meta = (isMine ? 'yours' : 'owner ' + String(c.owner || '').slice(0, 8)) +
                               (c.plan_status ? ' · ' + c.plan_status : '') +
                               (isActive ? ' · ACTIVE' : '');
                    row.appendChild(el('div', { style: 'flex:1;min-width:0;' },
                        '<div style="font-weight:600;font-size:0.88rem;color:var(--slate-700);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                          escapeHtml(label) + '</div>' +
                        '<div style="font-size:0.72rem;color:var(--slate-400);">' + escapeHtml(meta) + '</div>'));

                    var btns = el('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });

                    if (isMine) {
                        if (!isActive) {
                            var sw = el('button', { class: 'btn-secondary', style: 'padding:6px 10px;font-size:0.78rem;' }, 'Switch');
                            sw.onclick = function () { doSwitch(c.id); };
                            btns.appendChild(sw);
                        }
                        if (isCopy) {
                            var del = el('button', { style: 'padding:6px 10px;font-size:0.78rem;border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:8px;cursor:pointer;' }, 'Delete');
                            del.onclick = function () { doDelete(c.id, label); };
                            btns.appendChild(del);
                        }
                    } else {
                        var cp = el('button', { class: 'btn-primary', style: 'padding:6px 10px;font-size:0.78rem;' }, 'Make a copy');
                        cp.onclick = function () { doClone(c.id, label); };
                        btns.appendChild(cp);
                    }
                    row.appendChild(btns);
                    listEl.appendChild(row);
                });
            if (!listEl.children.length) {
                listEl.appendChild(el('div', { style: 'font-size:0.82rem;color:var(--slate-400);padding:8px;' }, 'No camps match.'));
            }
        }

        function load() {
            setStatus('Loading camps…');
            listCamps().then(function (camps) {
                allCamps = camps;
                setStatus(camps.length + ' camp(s).');
                draw();
            }).catch(function (e) {
                setStatus('Could not load camps: ' + (e && e.message) + ' (is migration 010 applied?)', true);
            });
        }

        function doClone(id, name) {
            if (!confirm('Make a full debug copy of "' + name + '"?\n\nThis reads the original (never changes it) and creates an editable copy on your account.')) return;
            setStatus('Cloning…');
            disableAll(true);
            cloneCamp(id, {
                sourceName: name,
                onProgress: function (m) { setStatus(m); }
            }).then(function (res) {
                setStatus('✅ Copied "' + name + '" → ' + res.copyName + ' (' +
                    res.counts.config + ' config keys, ' + res.counts.schedules + ' schedule rows, ' +
                    res.counts.rotation + ' rotation rows). Reloading into the copy…');
                setTimeout(function () { window.location.reload(); }, 1200);
            }).catch(function (e) {
                disableAll(false);
                setStatus('❌ Clone failed: ' + (e && e.message), true);
            });
        }

        function doSwitch(id) {
            setStatus('Switching…');
            disableAll(true);
            switchTo(id).then(function () {
                setStatus('Switched. Reloading…');
                setTimeout(function () { window.location.reload(); }, 600);
            }).catch(function (e) { disableAll(false); setStatus('❌ ' + (e && e.message), true); });
        }

        function doDelete(id, name) {
            if (!confirm('Delete the debug copy "' + name + '" and all its data?\nThis cannot be undone. (Originals are never affected.)')) return;
            setStatus('Deleting copy…');
            disableAll(true);
            deleteCopy(id).then(function () {
                setStatus('Copy deleted. Reloading…');
                setTimeout(function () { window.location.reload(); }, 600);
            }).catch(function (e) { disableAll(false); setStatus('⚠ ' + (e && e.message), true); load(); });
        }

        function disableAll(d) {
            section.querySelectorAll('button, input').forEach(function (b) { b.disabled = d; });
        }

        searchEl.addEventListener('input', draw);
        section.querySelector('#dcRefreshBtn').onclick = load;
        section.querySelector('#dcReturnBtn').onclick = function () {
            setStatus('Returning to your camp…');
            disableAll(true);
            returnToMyCamp().then(function () {
                setTimeout(function () { window.location.reload(); }, 600);
            }).catch(function (e) { disableAll(false); setStatus('❌ ' + (e && e.message), true); });
        };

        load();
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountWhenReady);
    } else {
        mountWhenReady();
    }

    log('camp_clone.js loaded');
})();
