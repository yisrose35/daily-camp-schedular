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

    function esc(s){
        var d=document.createElement('div');
        d.textContent=s==null?'':String(s);
        return d.innerHTML;
    }

    function renderAppSwitcher(activeKey){
        var html='<div class="quick-switch-bar">';
        APPS.forEach(function(a){
            if(a.key===activeKey){
                html+='<div class="quick-switch-active" data-app="'+a.key+'"><img src="'+a.img+'" alt="'+esc(a.name)+'"></div>';
            }else{
                html+='<a href="'+a.href+'" class="quick-switch-link" data-app="'+a.key+'" title="'+esc(a.title)+'"><img src="'+a.img+'" alt="'+esc(a.name)+'"></a>';
            }
        });
        html+='</div>';
        return html;
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
    }

    if(document.readyState==='loading'){
        document.addEventListener('DOMContentLoaded', mountAll);
    }else{
        mountAll();
    }

    window.CampistryAppSwitcher={render:renderAppSwitcher, mountAll:mountAll, APPS:APPS};
})();
