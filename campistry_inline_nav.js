// =============================================================================
// campistry_inline_nav.js — moves the top header controls INTO the page's own
// title row so the standalone header bar no longer eats a whole row.
//
// Why a script (and not just markup): each page/tab rebuilds its title row
// (.sec-hd) via innerHTML on every render, which would wipe any controls placed
// there. So we:
//   • hide the original .app-header (its real nodes stay in the DOM, listeners
//     intact — nothing is destroyed),
//   • keep the REAL search box + sync badge alive in a stable fixed overlay
//     (moved once out of the header) revealed by a search icon,
//   • re-inject a small, self-contained control cluster (hamburger + Menu
//     dropdown + search icon) at the start of the active page's .sec-hd after
//     every render, via a MutationObserver.
//
// The cluster's controls are self-contained (the hamburger just toggles the
// sidebar body class; the Menu is the shared app-switcher, driven by its own
// delegated handlers), so it's safe for them to be thrown away and rebuilt on
// each render. Scoped to Campistry Me only (included from campistry_me.html).
// =============================================================================
(function(){
    'use strict';

    var overlay=null, searchBtnRef=null, scheduled=false;

    function magnifierSvg(){
        return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    }

    function buildClusterHtml(){
        var menu = window.CampistryAppSwitcher ? window.CampistryAppSwitcher.render('me') : '';
        return '<div class="inav-cluster">'
            + '<button type="button" class="inav-ham" aria-label="Menu" title="Menu"><span></span><span></span><span></span></button>'
            + menu
            + '<button type="button" class="inav-search-btn" aria-label="Search" title="Search">'+magnifierSvg()+'</button>'
            + '</div>';
    }

    function ensureCluster(){
        var pg=document.querySelector('.me-page.active');
        if(!pg) return;
        if(pg.querySelector('.inav-cluster')) return; // already placed
        var host=pg.querySelector('.sec-hd') || pg; // prefer the title row; fall back to page top
        var tmp=document.createElement('div');
        tmp.innerHTML=buildClusterHtml();
        var cluster=tmp.firstChild;
        host.insertBefore(cluster, host.firstChild);
    }

    function scheduleEnsure(){
        if(scheduled) return; scheduled=true;
        (window.requestAnimationFrame||window.setTimeout)(function(){ scheduled=false; try{ ensureCluster(); }catch(e){} });
    }

    function positionSearch(){
        if(!overlay||!searchBtnRef||overlay.hasAttribute('hidden')) return;
        var r=searchBtnRef.getBoundingClientRect();
        overlay.style.top=(r.bottom+8)+'px';
        var w=overlay.offsetWidth||300;
        var left=Math.min(r.left, window.innerWidth-w-8);
        overlay.style.left=Math.max(8,left)+'px';
    }
    function showSearch(btn){
        if(!overlay) return;
        searchBtnRef=btn;
        overlay.removeAttribute('hidden');
        positionSearch();
        var inp=document.getElementById('globalSearch');
        if(inp){ try{ inp.focus(); }catch(e){} }
    }
    function hideSearch(){ if(overlay) overlay.setAttribute('hidden',''); }

    function onClick(e){
        var sb=e.target.closest && e.target.closest('.inav-search-btn');
        if(sb){ e.preventDefault(); if(overlay&&overlay.hasAttribute('hidden')) showSearch(sb); else hideSearch(); return; }
        var ham=e.target.closest && e.target.closest('.inav-ham');
        if(ham){ e.preventDefault(); document.body.classList.toggle('sidebar-open'); return; }
        // click outside the search overlay closes it
        if(overlay && !overlay.hasAttribute('hidden')
            && !(e.target.closest && (e.target.closest('.inav-search-pop')||e.target.closest('.inav-search-btn')))){
            hideSearch();
        }
    }

    function init(){
        var header=document.querySelector('.app-header');
        if(!header){ return; }
        document.body.classList.add('inline-nav'); // CSS hides .app-header

        // Move the real search box + sync badge into a stable overlay so their
        // listeners / live update targets survive (they're never re-rendered).
        overlay=document.createElement('div');
        overlay.className='inav-search-pop';
        overlay.setAttribute('hidden','');
        var sw=header.querySelector('.me-search-wrap'); if(sw) overlay.appendChild(sw);
        var sync=header.querySelector('.sync-badge'); if(sync) overlay.appendChild(sync);
        document.body.appendChild(overlay);

        var content=document.querySelector('.app-content')||document.body;
        var mo=new MutationObserver(scheduleEnsure);
        mo.observe(content,{childList:true,subtree:true});
        ensureCluster();

        document.addEventListener('click', onClick);
        document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideSearch(); });
        window.addEventListener('resize', function(){ hideSearch(); });
        window.addEventListener('scroll', function(){ hideSearch(); }, true);
    }

    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded', init);
    }else{
        init();
    }
})();
