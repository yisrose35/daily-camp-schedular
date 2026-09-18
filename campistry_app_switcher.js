// =============================================================================
// campistry_app_switcher.js — single source of truth for the "quick switch"
// pill bar that lets an owner/admin jump between Campistry's owner-facing
// apps. Previously each page hand-wrote its own copy of this bar (some using
// an older `.header-app-switch` link style, some the newer `.quick-switch-bar`
// pill style) and they'd drifted — e.g. Snacks was missing a link to Live,
// Health/Live never linked to Notes. One shared list + one render function
// means every page always shows the same complete set, in the same order,
// with no page able to silently fall behind when a new app ships.
//
// Deliberately excludes Campistry Link's parent/staff-facing pages and
// Campistry Lite (staff) and the Snacks POS screen — those are separate
// audiences with their own logins, not owner tools an admin tab-switches
// between. Only campistry_link_admin.html (the owner's Link management
// view) and campistry_snacks.html (the owner's Snacks admin, not the POS
// terminal) are in this list.
//
// Usage: include this script anywhere on the page, then drop
//   <div data-quick-switch-mount="me"></div>
// wherever the bar should render (the mount key is the app's own `key`
// below). The div is replaced in place once the DOM is ready.
// =============================================================================
(function(){
    'use strict';

    var APPS = [
        {key:'flow',   name:'Campistry Flow',   href:'flow.html',                 img:'Flow_clean.png',   title:'Campistry Flow — Scheduling'},
        {key:'go',     name:'Campistry Go',     href:'campistry_go.html',         img:'Go_clean.png',     title:'Campistry Go — Transportation'},
        {key:'me',     name:'Campistry Me',     href:'campistry_me.html',         img:'Me_clean.png',     title:'Campistry Me — Structure & Campers'},
        {key:'health', name:'Campistry Health', href:'campistry_health.html',     img:'Health_clean.png', title:'Campistry Health — Medical Records'},
        {key:'live',   name:'Campistry Live',   href:'campistry_live.html',       img:'Live_clean.png',   title:'Campistry Live — Daily Attendance'},
        {key:'snacks', name:'Campistry Snacks', href:'campistry_snacks.html',     img:'Snacks_clean.png', title:'Campistry Snacks — Canteen Management'},
        {key:'link',   name:'Campistry Link',   href:'campistry_link_admin.html', img:'Link_clean.png',   title:'Campistry Link — Parent Communication'},
        {key:'notes',  name:'Campistry Notes',  href:'campistry_notes.html',      img:'Notes_clean.png',  title:'Campistry Notes'}
    ];

    // Keyboard shortcuts: Ctrl+Shift+<letter> jumps to an app from anywhere.
    // Keyed by KeyboardEvent.code (layout-independent). Letters follow each
    // app's name where free; Live uses V because Link takes L.
    // NOTE: a few Ctrl+Shift combos are reserved by the browser itself and may
    // not reach the page — most notably Ctrl+Shift+N (new incognito window),
    // and sometimes Ctrl+Shift+S. Those apps are still reachable via the Apps
    // popover; the shortcut is best-effort.
    var SHORTCUTS={KeyF:'flow',KeyG:'go',KeyM:'me',KeyH:'health',KeyV:'live',KeyS:'snacks',KeyL:'link',KeyN:'notes'};
    function shortcutFor(appKey){
        for(var code in SHORTCUTS){ if(SHORTCUTS[code]===appKey) return 'Ctrl+Shift+'+code.replace('Key',''); }
        return '';
    }

    function esc(s){
        var d=document.createElement('div');
        d.textContent=s==null?'':String(s);
        return d.innerHTML;
    }

    // Short label used inside the popover grid (the pills used to show only an
    // icon; the grid shows icon + a short name). "Campistry Me" -> "Me".
    function shortName(name){ return String(name||'').replace(/^Campistry\s+/,''); }

    // The bar used to be a full 8-icon row taking a whole header column on
    // every page. It's now collapsed to a single "Apps" launcher button that
    // opens a popover grid — the row of icons only appears on demand, freeing
    // the header. Camps know which app they're in, so the trigger doesn't need
    // to name the active app.
    function renderAppSwitcher(activeKey){
        var html='<div class="quick-switch" data-active="'+esc(activeKey)+'">';
        html+='<button type="button" class="qs-trigger" aria-haspopup="true" aria-expanded="false" title="Switch apps">'
            +'<svg class="qs-grid-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">'
            +'<rect x="1" y="1" width="4" height="4" rx="1"></rect><rect x="6" y="1" width="4" height="4" rx="1"></rect><rect x="11" y="1" width="4" height="4" rx="1"></rect>'
            +'<rect x="1" y="6" width="4" height="4" rx="1"></rect><rect x="6" y="6" width="4" height="4" rx="1"></rect><rect x="11" y="6" width="4" height="4" rx="1"></rect>'
            +'<rect x="1" y="11" width="4" height="4" rx="1"></rect><rect x="6" y="11" width="4" height="4" rx="1"></rect><rect x="11" y="11" width="4" height="4" rx="1"></rect>'
            +'</svg><span class="qs-trigger-label">Menu</span>'
            +'<svg class="qs-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
            +'</button>';
        html+='<div class="qs-pop" role="menu" aria-hidden="true">';
        // Dashboard sits at the top of the same dropdown as the app toggles,
        // so the header no longer needs a separate "← Dashboard" link.
        html+='<a href="dashboard.html" class="qs-pop-dash" role="menuitem"><span class="qs-dash-arrow">&larr;</span> Dashboard</a>';
        html+='<div class="qs-pop-grid">';
        APPS.forEach(function(a){
            var isActive=a.key===activeKey;
            var sc=shortcutFor(a.key);
            html+='<a href="'+a.href+'" class="qs-pop-item'+(isActive?' is-active':'')+'" data-app="'+a.key+'" role="menuitem" title="'+esc(a.title)+(sc?' ('+sc+')':'')+'"'+(isActive?' aria-current="page"':'')+'>'
                +'<img src="'+a.img+'" alt="'+esc(a.name)+'">'
                +'<span>'+esc(shortName(a.name))+'</span>'
                +'</a>';
        });
        html+='</div></div></div>';
        return html;
    }

    // ── Popover open/close (event-delegated so it survives re-mounts and works
    //    for every page identically) ──────────────────────────────────────────
    function closeAll(except){
        var open=document.querySelectorAll('.quick-switch.open');
        for(var i=0;i<open.length;i++){
            if(except&&open[i]===except) continue;
            open[i].classList.remove('open');
            var t=open[i].querySelector('.qs-trigger'); if(t) t.setAttribute('aria-expanded','false');
            var p=open[i].querySelector('.qs-pop'); if(p) p.setAttribute('aria-hidden','true');
        }
    }

    // The header centre column sets overflow:hidden, which would clip a normal
    // absolutely-positioned popover — so the popover is position:fixed and we
    // compute its coordinates from the trigger's rect on open (same approach as
    // the header search dropdown).
    function positionPop(container){
        var trigger=container.querySelector('.qs-trigger');
        var pop=container.querySelector('.qs-pop');
        if(!trigger||!pop) return;
        var r=trigger.getBoundingClientRect();
        pop.style.top=(r.bottom+8)+'px';
        var popW=pop.offsetWidth||300;
        var left=r.left+r.width/2-popW/2;
        left=Math.max(8, Math.min(left, window.innerWidth-popW-8));
        pop.style.left=left+'px';
    }

    function openPop(container){
        closeAll(container);
        container.classList.add('open');
        var t=container.querySelector('.qs-trigger'); if(t) t.setAttribute('aria-expanded','true');
        var p=container.querySelector('.qs-pop'); if(p) p.setAttribute('aria-hidden','false');
        positionPop(container);
    }

    function onDocClick(e){
        var trigger=e.target.closest && e.target.closest('.qs-trigger');
        if(trigger){
            var container=trigger.closest('.quick-switch');
            if(container){
                e.preventDefault();
                if(container.classList.contains('open')) closeAll();
                else openPop(container);
            }
            return;
        }
        // A click inside the popover on an app link navigates normally; any
        // other click (outside) closes the menu.
        if(!(e.target.closest && e.target.closest('.qs-pop'))) closeAll();
    }

    var _wired=false;
    function wireGlobalHandlers(){
        if(_wired) return; _wired=true;
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', function(e){
            if(e.key==='Escape'){ closeAll(); return; }
            // Ctrl+Shift+<letter> app-jump (ignore when Alt/Meta also held).
            if(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey){
                var appKey=SHORTCUTS[e.code];
                if(!appKey) return;
                var app=null;
                for(var i=0;i<APPS.length;i++){ if(APPS[i].key===appKey){ app=APPS[i]; break; } }
                if(!app) return;
                e.preventDefault();
                // Don't reload if we're already on that app's page.
                if(window.location.pathname.split('/').pop()!==app.href) window.location.href=app.href;
            }
        });
        // A fixed popover would drift if the page scrolls or resizes under it;
        // simplest correct behaviour is to close it.
        window.addEventListener('resize', function(){ closeAll(); });
        window.addEventListener('scroll', function(){ closeAll(); }, true);
    }

    function mountAll(){
        var nodes=document.querySelectorAll('[data-quick-switch-mount]');
        for(var i=0;i<nodes.length;i++){
            var el=nodes[i];
            var key=el.getAttribute('data-quick-switch-mount');
            var tmp=document.createElement('div');
            tmp.innerHTML=renderAppSwitcher(key);
            el.replaceWith(tmp.firstChild);
        }
        if(nodes.length) wireGlobalHandlers();
    }

    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded', mountAll);
    }else{
        mountAll();
    }

    window.CampistryAppSwitcher={render:renderAppSwitcher, mountAll:mountAll, APPS:APPS};
})();
