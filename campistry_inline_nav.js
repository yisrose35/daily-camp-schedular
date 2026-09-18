// =============================================================================
// campistry_inline_nav.js — auto-hiding top header for Campistry Me.
//
// The standalone header bar (Dashboard, Menu/app-switcher, search, sync) is
// hidden off the top of the screen by default so it stops eating a whole row.
// It slides down when the user rests the mouse at the very top edge of the
// viewport for ~1.5s, or hovers the bar itself, and slides back up shortly
// after the mouse leaves. A small always-visible handle at the top-center hints
// that the bar is there.
//
// Nothing about the header's contents changes — it's the real .app-header with
// its real controls and listeners, just shown on demand. Scoped to Campistry
// Me (included from campistry_me.html); other apps are unchanged for now.
// =============================================================================
(function(){
    'use strict';

    var REVEAL_DELAY=1500;  // ms the mouse must rest at the top edge
    var HIDE_DELAY=450;     // grace period before hiding after mouse leaves

    function init(){
        var header=document.querySelector('.app-header');
        if(!header) return;
        document.body.classList.add('hoverbar');

        // Invisible strip along the very top edge that arms the reveal timer.
        var zone=document.createElement('div');
        zone.className='hoverbar-hotzone';
        document.body.appendChild(zone);

        // Small visible handle so the hidden bar is discoverable + clickable.
        var tab=document.createElement('button');
        tab.type='button';
        tab.className='hoverbar-tab';
        tab.setAttribute('aria-label','Show menu bar');
        tab.innerHTML='<span aria-hidden="true">&#9662;</span> Menu';
        document.body.appendChild(tab);

        var openTimer=null, hideTimer=null;

        function open(){ clearTimeout(hideTimer); document.body.classList.add('hoverbar-open'); }
        function close(){ document.body.classList.remove('hoverbar-open'); }
        function armOpen(){ clearTimeout(openTimer); openTimer=setTimeout(open, REVEAL_DELAY); }
        function cancelOpen(){ clearTimeout(openTimer); }
        // Don't hide while the Menu (app-switcher) popover is open — its items
        // render visually below the bar, so the pointer leaving the header
        // shouldn't yank the menu away mid-click. Recheck until it closes.
        function tryClose(){
            if(document.querySelector('.quick-switch.open')){ armHide(); return; }
            close();
        }
        function armHide(){ clearTimeout(hideTimer); hideTimer=setTimeout(tryClose, HIDE_DELAY); }

        zone.addEventListener('mouseenter', armOpen);
        zone.addEventListener('mouseleave', cancelOpen);

        // The handle reveals instantly on hover/click (no 1.5s wait) since it's
        // an explicit affordance.
        tab.addEventListener('mouseenter', open);
        tab.addEventListener('click', function(e){ e.preventDefault(); open(); });

        // Keep it open while the pointer is on the bar; hide shortly after it
        // leaves. Cancel any pending reveal timer once it's already open.
        header.addEventListener('mouseenter', function(){ cancelOpen(); open(); });
        header.addEventListener('mouseleave', armHide);

        document.addEventListener('keydown', function(e){ if(e.key==='Escape') close(); });
    }

    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded', init);
    }else{
        init();
    }
})();
