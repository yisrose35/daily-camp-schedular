/* campistry_notes_quick.js
   Drop-in Shift+N quick note for any Campistry page.
   Self-injects overlay markup + scoped styles. No dependencies. */
(function () {
    'use strict';

    var STORE_KEY = 'campistry_notes_v1';
    var open = false;

    // ── STYLES ────────────────────────────────────────────────────────────────
    var css = [
        '.cnq-overlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.38);',
            'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;',
            'animation:cnq-fi .18s ease}',
        '.cnq-overlay.cnq-hide{animation:cnq-fo .18s ease forwards}',
        '@keyframes cnq-fi{from{opacity:0}to{opacity:1}}',
        '@keyframes cnq-fo{from{opacity:1}to{opacity:0}}',
        '.cnq-card{width:min(460px,calc(100vw - 32px));background:#FEFCE8;border:2px solid #FEF08A;',
            'border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;',
            'animation:cnq-in .22s cubic-bezier(.16,1,.3,1);overflow:hidden;',
            'font-family:"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif}',
        '@keyframes cnq-in{from{transform:scale(.92) translateY(16px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}',
        '.cnq-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 6px}',
        '.cnq-lbl{font-size:.73rem;font-weight:700;letter-spacing:.06em;color:#C4891A;text-transform:uppercase}',
        '.cnq-hint{font-size:.7rem;color:#94A3B8;background:rgba(255,255,255,.6);border-radius:5px;padding:2px 8px}',
        '.cnq-title{width:100%;border:none;outline:none;background:transparent;',
            'font-size:1.05rem;font-weight:600;color:#0F172A;padding:2px 16px 6px;',
            "font-family:'Fraunces',Georgia,serif}",
        '.cnq-title::placeholder{color:#CBD5E1}',
        '.cnq-body{width:100%;border:none;outline:none;background:transparent;',
            'font-size:.9rem;line-height:1.65;color:#334155;padding:0 16px;',
            "resize:none;min-height:130px;font-family:'DM Sans',-apple-system,sans-serif}",
        '.cnq-body::placeholder{color:#CBD5E1}',
        '.cnq-ftr{display:flex;align-items:center;justify-content:flex-end;gap:8px;',
            'padding:10px 14px;border-top:1px solid #FEF08A;background:rgba(255,255,255,.4)}',
        '.cnq-open{font-size:.78rem;color:#9A6710;font-weight:600;background:none;border:none;',
            "cursor:pointer;font-family:'DM Sans',sans-serif;padding:4px 8px;border-radius:5px;",
            'text-decoration:none;transition:background .15s;display:inline-block}',
        '.cnq-open:hover{background:rgba(255,255,255,.6)}',
        '.cnq-save{padding:6px 16px;background:#C4891A;color:#fff;font-size:.82rem;font-weight:600;',
            "border:none;cursor:pointer;border-radius:8px;font-family:'DM Sans',sans-serif;transition:background .15s}",
        '.cnq-save:hover{background:#9A6710}',
        '#cnq-toast-box{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);',
            'z-index:100000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}',
        '.cnq-toast{background:#0F172A;color:#fff;padding:10px 20px;border-radius:10px;',
            "font-size:.83rem;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.15);",
            "font-family:'DM Sans',sans-serif;animation:cnq-fi .25s ease}"
    ].join('');

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // ── MARKUP ────────────────────────────────────────────────────────────────
    var html = [
        '<div class="cnq-overlay" id="cnqOverlay" style="display:none;">',
          '<div class="cnq-card">',
            '<div class="cnq-hdr">',
              '<span class="cnq-lbl">Quick Note</span>',
              '<span class="cnq-hint">Shift+N or Esc to save &amp; close</span>',
            '</div>',
            '<input type="text" class="cnq-title" id="cnqTitle" placeholder="Title (optional)…">',
            '<textarea class="cnq-body" id="cnqBody" placeholder="Jot something down…" rows="6"></textarea>',
            '<div class="cnq-ftr">',
              '<a href="campistry_notes.html" class="cnq-open">Open in Notes →</a>',
              '<button class="cnq-save" id="cnqSaveBtn">Save &amp; Close</button>',
            '</div>',
          '</div>',
        '</div>',
        '<div id="cnq-toast-box"></div>'
    ].join('');

    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    // ── HELPERS ───────────────────────────────────────────────────────────────
    function toast(msg) {
        var box = document.getElementById('cnq-toast-box');
        if (!box) return;
        var t = document.createElement('div');
        t.className = 'cnq-toast';
        t.textContent = msg;
        box.appendChild(t);
        setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2000);
        setTimeout(function () { t.remove(); }, 2400);
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function saveNote() {
        var title = (document.getElementById('cnqTitle') || {}).value || '';
        var body  = (document.getElementById('cnqBody')  || {}).value || '';
        title = title.trim(); body = body.trim();
        if (!title && !body) return;
        try {
            var s     = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            s.notes   = s.notes || [];
            s.notes.unshift({
                id: newId(), title: title, body: body,
                color: 'yellow', pinned: false, isShared: false,
                sharedWith: [], reminder: null, tags: [],
                trashed: false, createdAt: Date.now(), updatedAt: Date.now()
            });
            localStorage.setItem(STORE_KEY, JSON.stringify(s));
            toast('Note saved');
        } catch (e) { /* storage unavailable */ }
    }

    function doClose() {
        saveNote();
        open = false;
        var ov = document.getElementById('cnqOverlay');
        if (!ov) return;
        ov.classList.add('cnq-hide');
        setTimeout(function () {
            ov.style.display = 'none';
            ov.classList.remove('cnq-hide');
        }, 210);
    }

    function doOpen() {
        open = true;
        var ov = document.getElementById('cnqOverlay');
        if (!ov) return;
        var t = document.getElementById('cnqTitle');
        var b = document.getElementById('cnqBody');
        if (t) t.value = '';
        if (b) b.value = '';
        ov.style.display = 'flex';
        ov.classList.remove('cnq-hide');
        setTimeout(function () { if (b) b.focus(); }, 60);
    }

    // ── EVENTS ────────────────────────────────────────────────────────────────
    document.addEventListener('keydown', function (e) {
        if (e.shiftKey && (e.key === 'N' || e.key === 'n') && !e.ctrlKey && !e.metaKey) {
            var tag = (document.activeElement || {}).tagName || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            e.preventDefault();
            open ? doClose() : doOpen();
        }
        if (e.key === 'Escape' && open) doClose();
    });

    document.addEventListener('click', function (e) {
        var ov = document.getElementById('cnqOverlay');
        if (ov && e.target === ov) doClose();
    });

    // Wire save button (appended after DOM ready)
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.getElementById('cnqSaveBtn');
        if (btn) btn.addEventListener('click', doClose);
    });
    // If DOMContentLoaded already fired (script at bottom of body):
    var btn = document.getElementById('cnqSaveBtn');
    if (btn) btn.addEventListener('click', doClose);

})();
