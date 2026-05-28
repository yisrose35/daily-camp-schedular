'use strict';

// ─── STORAGE ─────────────────────────────────────────────────────────────────
var STORE_KEY = 'campistry_notes_v1';

function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch(e) { return {}; }
}
function saveStore(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }

function getNotes() { var s = loadStore(); return s.notes || []; }
function setNotes(arr) { var s = loadStore(); s.notes = arr; saveStore(s); }

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// ─── STATE ───────────────────────────────────────────────────────────────────
var currentView   = 'all';
var currentNoteId = null;
var isGridView    = true;
var searchQuery   = '';
var editorSaveTimer = null;

// ─── VIEWS ───────────────────────────────────────────────────────────────────
var VIEWS = {
    all:       { label: 'All Notes',  filter: function(n){ return !n.trashed; } },
    pinned:    { label: 'Pinned',     filter: function(n){ return !n.trashed && n.pinned; } },
    shared:    { label: 'Shared',     filter: function(n){ return !n.trashed && n.isShared; } },
    reminders: { label: 'Reminders',  filter: function(n){ return !n.trashed && !!n.reminder; } },
    trash:     { label: 'Trash',      filter: function(n){ return !!n.trashed; } }
};

// ─── RENDER NOTES GRID ───────────────────────────────────────────────────────
function renderGrid() {
    var notes = getNotes();
    var view  = VIEWS[currentView] || VIEWS.all;
    var list  = notes.filter(view.filter);

    if (searchQuery) {
        var q = searchQuery.toLowerCase();
        list = list.filter(function(n) {
            return (n.title + ' ' + n.body + ' ' + (n.tags||[]).join(' ')).toLowerCase().indexOf(q) >= 0;
        });
    }

    // Pinned first
    list.sort(function(a,b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return  1;
        return b.updatedAt - a.updatedAt;
    });

    var grid = document.getElementById('notesGrid');
    var empty = document.getElementById('emptyState');
    if (!grid) return;

    grid.className = 'nt-grid' + (isGridView ? '' : ' list-view');

    if (!list.length) {
        grid.innerHTML = '';
        if (empty) empty.style.display = 'flex';
        return;
    }
    if (empty) empty.style.display = 'none';

    grid.innerHTML = list.map(function(n) {
        var color = n.color || 'yellow';
        var date  = new Date(n.updatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'});
        var pinBadge = n.pinned ? '<span class="nt-card-pin">📌</span>' : '';
        var badges = '';
        if (n.isShared) badges += '<span class="nt-badge" title="Shared">👥</span>';
        if (n.reminder) badges += '<span class="nt-reminder-badge">🔔 ' + fmtReminderDate(n.reminder.date) + '</span>';
        var tagChips = (n.tags || []).slice(0,2).map(function(t){
            return '<span class="nt-tag-chip" style="font-size:.6rem;">#'+esc(t)+'</span>';
        }).join('');
        return '<div class="nt-card' + (n.id === currentNoteId ? ' selected' : '') + '" data-color="'+color+'" data-id="'+n.id+'" onclick="openEditor(\''+n.id+'\')">' +
            pinBadge +
            (n.title ? '<div class="nt-card-title">'+esc(n.title)+'</div>' : '') +
            '<div class="nt-card-body">'+(n.body ? esc(n.body) : '<em style="color:#CBD5E1;">Empty note</em>')+'</div>' +
            '<div class="nt-card-footer">' +
                '<span class="nt-card-date">'+date+'</span>' +
                '<span class="nt-card-badges">'+badges+'</span>' +
            '</div>' +
            (tagChips ? '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px;">'+tagChips+'</div>' : '') +
        '</div>';
    }).join('');

    updateCounts();
}

function fmtReminderDate(d) {
    if (!d) return '';
    var parts = d.split('-');
    return (parts[1]||'') + '/' + (parts[2]||'');
}

function updateCounts() {
    var notes = getNotes();
    document.querySelectorAll('.nt-nav-item[data-view]').forEach(function(btn) {
        var v = btn.dataset.view;
        var view = VIEWS[v];
        var cnt = view ? notes.filter(view.filter).length : 0;
        var el = btn.querySelector('.nt-nav-count');
        if (el) el.textContent = cnt || '';
    });
    renderSidebarTags();
}

function renderSidebarTags() {
    var notes = getNotes().filter(function(n){ return !n.trashed; });
    var tagMap = {};
    notes.forEach(function(n){ (n.tags||[]).forEach(function(t){ tagMap[t] = (tagMap[t]||0)+1; }); });
    var box = document.getElementById('sidebarTagsBox');
    if (!box) return;
    var tags = Object.keys(tagMap);
    box.innerHTML = tags.length
        ? tags.map(function(t){ return '<span class="nt-sidebar-tag" onclick="filterByTag(\''+esc(t)+'\')"><span>#</span>'+esc(t)+'</span>'; }).join('')
        : '';
    box.style.display = tags.length ? 'block' : 'none';
}

// ─── VIEW SWITCH ─────────────────────────────────────────────────────────────
function switchView(view) {
    currentView = view;
    document.querySelectorAll('.nt-nav-item[data-view]').forEach(function(b){
        b.classList.toggle('active', b.dataset.view === view);
    });
    var title = document.getElementById('viewTitle');
    if (title) title.textContent = (VIEWS[view]||VIEWS.all).label;
    renderGrid();
}

function filterByTag(tag) {
    searchQuery = '#' + tag;
    var si = document.getElementById('searchInput');
    if (si) si.value = searchQuery;
    currentView = 'all';
    renderGrid();
}

// ─── CREATE NOTE ─────────────────────────────────────────────────────────────
function createNote(opts) {
    opts = opts || {};
    var note = {
        id:        newId(),
        title:     opts.title || '',
        body:      opts.body  || '',
        color:     opts.color || 'yellow',
        pinned:    false,
        isShared:  false,
        sharedWith:[],
        reminder:  null,
        tags:      [],
        trashed:   false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    var notes = getNotes();
    notes.unshift(note);
    setNotes(notes);
    return note;
}

// ─── EDITOR ──────────────────────────────────────────────────────────────────
function openEditor(id) {
    var notes = getNotes();
    var note = notes.find(function(n){ return n.id === id; });
    if (!note) return;

    currentNoteId = id;

    var panel = document.getElementById('editorPanel');
    if (panel) panel.classList.add('open');

    // Title
    var titleEl = document.getElementById('editorTitle');
    if (titleEl) titleEl.value = note.title || '';

    // Body
    var bodyEl = document.getElementById('editorBody');
    if (bodyEl) bodyEl.value = note.body || '';

    // Color
    document.querySelectorAll('.nt-color-dot').forEach(function(d){
        d.classList.toggle('selected', d.dataset.c === (note.color || 'yellow'));
    });
    var scroll = document.getElementById('editorScroll');
    if (scroll) scroll.style.background = 'transparent';

    // Pin button
    var pinBtn = document.getElementById('pinBtn');
    if (pinBtn) pinBtn.classList.toggle('active', !!note.pinned);

    // Share btn
    var shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.classList.toggle('active', !!note.isShared);

    // Reminder btn
    var remBtn = document.getElementById('remBtn');
    if (remBtn) remBtn.classList.toggle('active', !!note.reminder);

    // Tags
    renderEditorTags();

    // Meta
    renderEditorMeta(note);

    // Close sub-panels
    hideSubPanel('sharePanel');
    hideSubPanel('reminderPanel');

    // Highlight card
    document.querySelectorAll('.nt-card').forEach(function(c){
        c.classList.toggle('selected', c.dataset.id === id);
    });

    // Focus body
    if (bodyEl) setTimeout(function(){ bodyEl.focus(); }, 50);
}

function closeEditor() {
    saveCurrentNote();
    currentNoteId = null;
    var panel = document.getElementById('editorPanel');
    if (panel) panel.classList.remove('open');
    document.querySelectorAll('.nt-card').forEach(function(c){ c.classList.remove('selected'); });
    renderGrid();
}

function saveCurrentNote() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    var titleEl = document.getElementById('editorTitle');
    var bodyEl  = document.getElementById('editorBody');
    notes[idx].title     = titleEl ? titleEl.value : notes[idx].title;
    notes[idx].body      = bodyEl  ? bodyEl.value  : notes[idx].body;
    notes[idx].updatedAt = Date.now();
    setNotes(notes);
}

function scheduleSave() {
    clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(function(){ saveCurrentNote(); renderGrid(); }, 600);
}

function renderEditorMeta(note) {
    var meta = document.getElementById('editorMeta');
    if (!meta) return;
    var created = new Date(note.createdAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    var updated = new Date(note.updatedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
    meta.textContent = 'Created ' + created + ' · Last saved ' + updated;
}

function renderEditorTags() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var note  = notes.find(function(n){ return n.id === currentNoteId; });
    if (!note) return;
    var box = document.getElementById('editorTagsRow');
    if (!box) return;
    box.innerHTML = (note.tags||[]).map(function(t){
        return '<span class="nt-tag-chip">#'+esc(t)+'<button class="nt-tag-chip-del" onclick="removeTag(\''+esc(t)+'\')">×</button></span>';
    }).join('') + '<input type="text" class="nt-tag-input" id="tagInput" placeholder="Add tag..." onkeydown="tagKeydown(event)">';
}

function tagKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    var val = e.target.value.trim().replace(/^#/, '');
    if (!val || !currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    if (!(notes[idx].tags||[]).includes(val)) {
        notes[idx].tags = (notes[idx].tags||[]).concat(val);
        notes[idx].updatedAt = Date.now();
        setNotes(notes);
    }
    renderEditorTags();
    renderGrid();
}

function removeTag(t) {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].tags = (notes[idx].tags||[]).filter(function(x){ return x !== t; });
    setNotes(notes);
    renderEditorTags();
    renderGrid();
}

// ─── EDITOR ACTIONS ──────────────────────────────────────────────────────────
function togglePin() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].pinned = !notes[idx].pinned;
    setNotes(notes);
    var btn = document.getElementById('pinBtn');
    if (btn) btn.classList.toggle('active', notes[idx].pinned);
    toast(notes[idx].pinned ? 'Note pinned' : 'Note unpinned');
    renderGrid();
}

function setColor(c) {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].color = c;
    notes[idx].updatedAt = Date.now();
    setNotes(notes);
    document.querySelectorAll('.nt-color-dot').forEach(function(d){
        d.classList.toggle('selected', d.dataset.c === c);
    });
    renderGrid();
}

function deleteNote() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    if (notes[idx].trashed) {
        if (!confirm('Permanently delete this note?')) return;
        notes.splice(idx, 1);
        toast('Note deleted');
    } else {
        notes[idx].trashed = true;
        toast('Moved to trash');
    }
    setNotes(notes);
    closeEditor();
}

function restoreNote() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].trashed = false;
    setNotes(notes);
    toast('Note restored');
    closeEditor();
}

// ─── SHARE ───────────────────────────────────────────────────────────────────
function toggleSharePanel() {
    var p = document.getElementById('sharePanel');
    if (!p) return;
    var open = p.style.display !== 'none';
    hideSubPanel('reminderPanel');
    p.style.display = open ? 'none' : 'block';
    if (!open) renderShareList();
}

function renderShareList() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var note = notes.find(function(n){ return n.id === currentNoteId; });
    if (!note) return;
    var box = document.getElementById('sharePeopleList');
    if (!box) return;
    box.innerHTML = (note.sharedWith||[]).length
        ? (note.sharedWith||[]).map(function(e){
            return '<span class="nt-shared-chip">'+esc(e)+'<button onclick="removeShare(\''+esc(e)+'\')">×</button></span>';
          }).join('')
        : '<span style="font-size:.75rem;color:#94A3B8;">Not shared with anyone yet</span>';
}

function addShare() {
    var inp = document.getElementById('shareEmailInput');
    if (!inp || !currentNoteId) return;
    var email = inp.value.trim();
    if (!email || !email.includes('@')) { toast('Enter a valid email'); return; }
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    if (!(notes[idx].sharedWith||[]).includes(email)) {
        notes[idx].sharedWith = (notes[idx].sharedWith||[]).concat(email);
        notes[idx].isShared = true;
        setNotes(notes);
    }
    inp.value = '';
    renderShareList();
    renderGrid();
    toast('Shared with ' + email);
    var btn = document.getElementById('shareBtn');
    if (btn) btn.classList.add('active');
}

function removeShare(email) {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].sharedWith = (notes[idx].sharedWith||[]).filter(function(e){ return e !== email; });
    notes[idx].isShared = notes[idx].sharedWith.length > 0;
    setNotes(notes);
    renderShareList();
    renderGrid();
}

// ─── REMINDERS ───────────────────────────────────────────────────────────────
function toggleReminderPanel() {
    var p = document.getElementById('reminderPanel');
    if (!p) return;
    var open = p.style.display !== 'none';
    hideSubPanel('sharePanel');
    p.style.display = open ? 'none' : 'block';
    if (!open && currentNoteId) {
        var notes = getNotes();
        var note = notes.find(function(n){ return n.id === currentNoteId; });
        if (note && note.reminder) {
            var d = document.getElementById('remDateInput'); if (d) d.value = note.reminder.date || '';
            var t = document.getElementById('remTimeInput'); if (t) t.value = note.reminder.time || '';
            var m = document.getElementById('remMsgInput');  if (m) m.value = note.reminder.msg  || '';
        }
    }
}

function saveReminder() {
    if (!currentNoteId) return;
    var d = document.getElementById('remDateInput');
    var t = document.getElementById('remTimeInput');
    var m = document.getElementById('remMsgInput');
    if (!d || !d.value) { toast('Pick a date'); return; }
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].reminder = { date: d.value, time: t ? t.value : '', msg: m ? m.value : '' };
    notes[idx].updatedAt = Date.now();
    setNotes(notes);
    var btn = document.getElementById('remBtn');
    if (btn) btn.classList.add('active');
    hideSubPanel('reminderPanel');
    toast('Reminder set for ' + d.value);
    renderGrid();
}

function clearReminder() {
    if (!currentNoteId) return;
    var notes = getNotes();
    var idx = notes.findIndex(function(n){ return n.id === currentNoteId; });
    if (idx < 0) return;
    notes[idx].reminder = null;
    setNotes(notes);
    var btn = document.getElementById('remBtn');
    if (btn) btn.classList.remove('active');
    hideSubPanel('reminderPanel');
    toast('Reminder cleared');
    renderGrid();
}

function hideSubPanel(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ─── QUICK NOTE ──────────────────────────────────────────────────────────────
var quickIsOpen = false;
var quickNoteId = null;

function openQuickNote() {
    if (quickIsOpen) { closeQuickNote(); return; }
    quickIsOpen = true;
    var overlay = document.getElementById('quickOverlay');
    if (overlay) { overlay.style.display = 'flex'; overlay.classList.remove('hide'); }
    var titleEl = document.getElementById('quickTitle');
    var bodyEl  = document.getElementById('quickBody');
    if (titleEl) titleEl.value = '';
    if (bodyEl)  { bodyEl.value = ''; setTimeout(function(){ bodyEl.focus(); }, 60); }
    quickNoteId = null;
}

function closeQuickNote() {
    saveQuickNote();
    quickIsOpen = false;
    var overlay = document.getElementById('quickOverlay');
    if (!overlay) return;
    overlay.classList.add('hide');
    setTimeout(function(){
        overlay.style.display = 'none';
        overlay.classList.remove('hide');
    }, 200);
}

function saveQuickNote() {
    var titleEl = document.getElementById('quickTitle');
    var bodyEl  = document.getElementById('quickBody');
    var title = titleEl ? titleEl.value.trim() : '';
    var body  = bodyEl  ? bodyEl.value.trim()  : '';
    if (!title && !body) return;
    var note = createNote({ title: title, body: body, color: 'yellow' });
    quickNoteId = note.id;
    renderGrid();
    toast('Note saved');
}

function openQuickInFull() {
    saveQuickNote();
    closeQuickNote();
    if (quickNoteId) {
        openEditor(quickNoteId);
    }
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
    // Shift+N — toggle quick note
    if (e.shiftKey && (e.key === 'N' || e.key === 'n') && !e.ctrlKey && !e.metaKey) {
        var tag = (document.activeElement||{}).tagName || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        openQuickNote();
        return;
    }
    // Escape — close editor or quick note
    if (e.key === 'Escape') {
        if (quickIsOpen) { closeQuickNote(); return; }
        if (currentNoteId) { closeEditor(); return; }
    }
});

// Close quick note when clicking backdrop
document.addEventListener('click', function(e) {
    var overlay = document.getElementById('quickOverlay');
    if (overlay && e.target === overlay) closeQuickNote();
});

// ─── MISC ─────────────────────────────────────────────────────────────────────
function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
}

function toast(msg) {
    var box = document.getElementById('nt-toast-box');
    if (!box) return;
    var t = document.createElement('div');
    t.className = 'nt-toast';
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .3s'; }, 2200);
    setTimeout(function(){ t.remove(); }, 2500);
}

// ─── BOOT ────────────────────────────────────────────────────────────────────
(function boot() {
    // Splash
    setTimeout(function(){
        var s = document.getElementById('notes-splash');
        if (s) { s.classList.add('hide'); setTimeout(function(){ s.style.display='none'; }, 500); }
    }, 2000);

    // Seed demo notes if empty
    var notes = getNotes();
    if (!notes.length) {
        createNote({ title:'Welcome to Campistry Notes', body:'Press Shift+N anywhere to jot something down instantly.\n\nUse the sidebar to pin, share, or set reminders on your notes.', color:'yellow' });
        createNote({ title:'Staff meeting — June 10', body:'- Review daily schedule\n- Rainy day backup plan\n- Bunk assignment updates', color:'blue' });
        createNote({ title:'Supply list', body:'Bug spray ✓\nSunscreen\nFirst aid restock\nCraft supplies — need more paint', color:'green' });
    }

    renderGrid();
    updateCounts();

    // Set user initials
    try {
        var settings = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
        var name = settings.campName || '';
        var av = document.getElementById('ntAvatar');
        if (av && name) av.textContent = name.slice(0,2).toUpperCase();
    } catch(e) {}
})();
