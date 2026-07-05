// ============================================================================
// badges.js — CAMP ACHIEVEMENTS v2.0
// ============================================================================
// Per-camp achievements, displayed on the dashboard and awarded live.
//
// Categories:
//   Milestones  — daily schedules generated (1 / 10 / 50 / 100)
//   Years       — tenure with Campistry (camps.created_at)
//   Enrollment  — campers enrolled (camperRoster count, else bunkMetaData sizes)
//   Secret      — the easter egg (awarded by easter_egg.js via CampBadges.award)
//
// Presentation (v2): tiered metal medallions (bronze/silver/gold/platinum)
// instead of emoji, refined award toast with a shine sweep instead of
// confetti. Badge IDs are unchanged from v1 — earned cloud data carries over.
//
// Storage: camp_state_kv key 'campBadges' → { earned: { badgeId: isoDate } }
// (direct Supabase upsert with read-merge-union so badges are never lost to a
// stale cache; localStorage mirror per camp for resilience). Badges only ever
// accumulate — merge = union with earliest timestamp.
//
// Runs on BOTH pages:
//   dashboard.html — renders the collection into #campBadgesGrid + evaluates
//   flow.html      — listens for 'campistry-schedule-generated' + evaluates
//
// Award moment: sliding toast (queued; >3 at once collapses into a summary
// toast). Kill switch: window.__campBadges = false
// ============================================================================
(function(){
'use strict';

const KV_KEY = "campBadges";
const LOCAL_MIRROR_PREFIX = "campistry_badges_v1:";
const TOAST_MS = 3400;

// =========================================================================
// BADGE DEFINITIONS (ids are persisted in the cloud — never change them)
// =========================================================================
// medal = short text shown inside the medallion; tier = metal rank.
// check(stats) — stats fields may be undefined when unknown; comparisons
// against undefined are false, so badges never award on missing data.
const BADGE_DEFS = [
    // Milestones — schedules generated
    { id: "first_schedule", medal: "1",   tier: "bronze",   name: "First Schedule", cat: "Milestones", desc: "Generated your first daily schedule", check: s => s.schedules >= 1 },
    { id: "schedules_10",   medal: "10",  tier: "silver",   name: "10 Schedules",   cat: "Milestones", desc: "10 daily schedules generated",        check: s => s.schedules >= 10 },
    { id: "schedules_50",   medal: "50",  tier: "gold",     name: "50 Schedules",   cat: "Milestones", desc: "50 daily schedules generated",        check: s => s.schedules >= 50 },
    { id: "schedules_100",  medal: "100", tier: "platinum", name: "100 Schedules",  cat: "Milestones", desc: "100 daily schedules generated",       check: s => s.schedules >= 100 },
    // Years with Campistry
    { id: "rookie_season",  medal: "★",  tier: "bronze",   name: "First Season", cat: "Years with Campistry", desc: "Joined Campistry",            check: s => s.years >= 0 },
    { id: "second_summer",  medal: "1Y", tier: "silver",   name: "One Year",     cat: "Years with Campistry", desc: "One year with Campistry",     check: s => s.years >= 1 },
    { id: "camp_veteran",   medal: "3Y", tier: "gold",     name: "Three Years",  cat: "Years with Campistry", desc: "Three years with Campistry",  check: s => s.years >= 3 },
    { id: "founding_legend",medal: "5Y", tier: "platinum", name: "Five Years",   cat: "Years with Campistry", desc: "Five years with Campistry",   check: s => s.years >= 5 },
    // Enrollment
    { id: "campers_50",     medal: "50",  tier: "bronze",   name: "50 Campers",  cat: "Enrollment", desc: "50+ campers enrolled",  check: s => s.campers >= 50 },
    { id: "campers_100",    medal: "100", tier: "silver",   name: "100 Campers", cat: "Enrollment", desc: "100+ campers enrolled", check: s => s.campers >= 100 },
    { id: "campers_250",    medal: "250", tier: "gold",     name: "250 Campers", cat: "Enrollment", desc: "250+ campers enrolled", check: s => s.campers >= 250 },
    { id: "campers_500",    medal: "500", tier: "platinum", name: "500 Campers", cat: "Enrollment", desc: "500+ campers enrolled", check: s => s.campers >= 500 },
    // Secret — event-awarded only (no check)
    { id: "egg_hunter",     medal: "★",  tier: "accent",   name: "Easter Egg",  cat: "Secret", desc: "Discovered the hidden easter egg", secret: true },
];

const CATEGORY_ORDER = ["Milestones", "Years with Campistry", "Enrollment", "Secret"];

// =========================================================================
// IDENTITY + PERSISTENCE
// =========================================================================
async function resolveCampId() {
    try {
        const direct = window.getCampId ? window.getCampId() : null;
        if (direct) return direct;
    } catch (_) {}
    const cached = localStorage.getItem("campistry_camp_id") || localStorage.getItem("campistry_user_id");
    if (cached) return cached;
    try {
        const { data } = await window.supabase.auth.getUser();
        return data?.user?.id || null;
    } catch (_) { return null; }
}

function mirrorKey(campId) { return LOCAL_MIRROR_PREFIX + campId; }

function readMirror(campId) {
    try { return JSON.parse(localStorage.getItem(mirrorKey(campId)) || "null") || { earned: {} }; }
    catch (_) { return { earned: {} }; }
}

function writeMirror(campId, state) {
    try { localStorage.setItem(mirrorKey(campId), JSON.stringify(state)); } catch (_) {}
}

// Union merge — badges only accumulate; earliest earned timestamp wins.
function mergeStates(a, b) {
    const earned = {};
    [a, b].forEach(st => {
        Object.entries((st && st.earned) || {}).forEach(([id, ts]) => {
            if (!earned[id] || String(ts) < String(earned[id])) earned[id] = ts;
        });
    });
    return { earned };
}

async function loadCloudState(campId) {
    try {
        const { data, error } = await window.supabase
            .from("camp_state_kv")
            .select("value")
            .eq("camp_id", campId)
            .eq("key", KV_KEY);
        if (error) return null;
        return (data && data[0] && data[0].value) || { earned: {} };
    } catch (_) { return null; }
}

async function saveCloudState(campId, state) {
    try {
        const { error } = await window.supabase
            .from("camp_state_kv")
            .upsert(
                { camp_id: campId, key: KV_KEY, value: state, updated_at: new Date().toISOString() },
                { onConflict: "camp_id,key" }
            );
        return !error;
    } catch (_) { return false; }
}

// Load merged state (cloud ∪ local mirror). Cloud unreachable → mirror only.
async function loadState(campId) {
    const cloud = await loadCloudState(campId);
    const merged = mergeStates(cloud || { earned: {} }, readMirror(campId));
    writeMirror(campId, merged);
    return merged;
}

// Persist: re-merge against current cloud right before writing so a
// concurrent award from another device is never clobbered.
async function persistState(campId, state) {
    const cloud = await loadCloudState(campId);
    const merged = mergeStates(cloud || { earned: {} }, state);
    writeMirror(campId, merged);
    await saveCloudState(campId, merged);
    return merged;
}

// =========================================================================
// STATS COLLECTION (works on both pages; unknown → undefined)
// =========================================================================
async function collectStats(campId) {
    const stats = {};

    // -- schedules generated (distinct cloud dates) --
    try {
        if (window.ScheduleDB && window.ScheduleDB.listScheduleDates) {
            const dates = await window.ScheduleDB.listScheduleDates();
            if (Array.isArray(dates)) stats.schedules = dates.length;
        }
        if (stats.schedules === undefined) {
            const { data, error } = await window.supabase
                .from("daily_schedules")
                .select("date_key")
                .eq("camp_id", campId);
            if (!error && Array.isArray(data)) {
                const seen = {};
                data.forEach(r => { if (r && r.date_key) seen[String(r.date_key).substring(0, 10)] = 1; });
                stats.schedules = Object.keys(seen).length;
            }
        }
    } catch (_) {}

    // -- campers enrolled (roster count, else bunkMetaData size sum) --
    try {
        const { data, error } = await window.supabase
            .from("camp_state_kv")
            .select("key, value")
            .eq("camp_id", campId)
            .in("key", ["app1", "bunkMetaData"]);
        if (!error && Array.isArray(data)) {
            const state = {};
            data.forEach(r => { state[r.key] = r.value; });
            const roster = state.app1?.camperRoster || {};
            let campers = Object.keys(roster).length;
            if (campers === 0) {
                const bunkMeta = state.bunkMetaData || state.app1?.bunkMetaData || {};
                Object.values(bunkMeta).forEach(meta => { campers += (meta && meta.size) || 0; });
            }
            stats.campers = campers;
        }
    } catch (_) {}

    // -- years with the program (camps.created_at; may be RLS-blocked for
    //    scheduler-role users → tenure just doesn't evaluate on that client) --
    try {
        const { data, error } = await window.supabase
            .from("camps")
            .select("created_at")
            .eq("id", campId);
        const created = !error && data && data[0] && data[0].created_at;
        if (created) {
            const ms = Date.now() - new Date(created).getTime();
            if (ms >= 0) stats.years = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
        }
    } catch (_) {}

    return stats;
}

// =========================================================================
// AWARD ENGINE
// =========================================================================
let _campId = null;
let _state = null;          // { earned: {id: iso} }
let _initPromise = null;

async function ensureInit() {
    if (!_initPromise) {
        _initPromise = (async () => {
            // supabase client can lag page load — poll briefly
            for (let i = 0; i < 60 && !(window.supabase && window.supabase.from); i++) {
                await new Promise(r => setTimeout(r, 250));
            }
            if (!(window.supabase && window.supabase.from)) return false;
            for (let i = 0; i < 40 && !_campId; i++) {
                _campId = await resolveCampId();
                if (!_campId) await new Promise(r => setTimeout(r, 500));
            }
            if (!_campId) return false;
            _state = await loadState(_campId);
            return true;
        })();
    }
    return _initPromise;
}

function isEarned(id) { return !!(_state && _state.earned && _state.earned[id]); }

// Award one badge by id (used by evaluate + external callers like the egg).
async function award(id, opts) {
    if (window.__campBadges === false) return false;
    const def = BADGE_DEFS.find(d => d.id === id);
    if (!def) return false;
    if (!(await ensureInit())) return false;
    if (isEarned(id)) return false;
    _state.earned[id] = new Date().toISOString();
    _state = await persistState(_campId, _state);
    if (!(opts && opts.silent)) queueToast([def]);
    renderIfPresent();
    return true;
}

// Evaluate all stat-based badges; awards everything newly qualified.
async function evaluate(statsOverride) {
    if (window.__campBadges === false) return [];
    if (!(await ensureInit())) return [];
    const stats = statsOverride || await collectStats(_campId);
    const newly = BADGE_DEFS.filter(d => d.check && !isEarned(d.id) && d.check(stats));
    if (newly.length === 0) return [];
    const now = new Date().toISOString();
    newly.forEach(d => { _state.earned[d.id] = now; });
    _state = await persistState(_campId, _state);
    queueToast(newly);
    renderIfPresent();
    return newly.map(d => d.id);
}

// =========================================================================
// AWARD TOAST (queued, sequential; refined — no confetti)
// =========================================================================
const _toastQueue = [];
let _toastActive = false;

function queueToast(defs) {
    // >3 at once (e.g. retroactive first run): show 2, collapse the rest
    if (defs.length > 3) {
        _toastQueue.push(defs[0], defs[1], {
            medal: "+" + (defs.length - 2), tier: "gold",
            name: (defs.length - 2) + " more achievements earned",
            desc: "See the full collection on your Dashboard", _summary: true,
        });
    } else {
        _toastQueue.push(...defs);
    }
    pumpToasts();
}

function pumpToasts() {
    if (_toastActive) return;
    const def = _toastQueue.shift();
    if (!def) return;
    _toastActive = true;
    injectStyles();

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const toast = document.createElement("div");
    toast.className = "cbadge-toast" + (reducedMotion ? " cbadge-noanim" : "");
    toast.innerHTML = [
        `<div class="cbadge-medal cbadge-tier-${def.tier}"><span class="cbadge-medal-text"></span></div>`,
        '<div class="cbadge-toast-text">',
        '  <div class="cbadge-toast-kicker">Achievement unlocked</div>',
        '  <div class="cbadge-toast-name"></div>',
        '  <div class="cbadge-toast-desc"></div>',
        '</div>',
    ].join("");
    toast.querySelector(".cbadge-medal-text").textContent = def.medal;
    toast.querySelector(".cbadge-toast-name").textContent = def.name;
    toast.querySelector(".cbadge-toast-desc").textContent = def.desc || "";
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add("cbadge-out");
        setTimeout(() => {
            toast.remove();
            _toastActive = false;
            pumpToasts();
        }, 350);
    }, TOAST_MS);
}

// =========================================================================
// DASHBOARD COLLECTION RENDER
// =========================================================================
function renderIfPresent() {
    const grid = document.getElementById("campBadgesGrid");
    if (grid && _state) renderCollection(grid);
}

function renderCollection(grid) {
    injectStyles();
    const earned = (_state && _state.earned) || {};
    const earnedCount = BADGE_DEFS.filter(d => earned[d.id]).length;

    const counter = document.getElementById("campBadgesCount");
    if (counter) counter.textContent = `${earnedCount} of ${BADGE_DEFS.length} earned`;

    grid.innerHTML = "";
    CATEGORY_ORDER.forEach(cat => {
        const defs = BADGE_DEFS.filter(d => d.cat === cat);
        if (!defs.length) return;
        const header = document.createElement("div");
        header.className = "cbadge-cat";
        header.textContent = cat;
        grid.appendChild(header);

        const row = document.createElement("div");
        row.className = "cbadge-grid";
        defs.forEach(def => {
            const got = earned[def.id];
            const hidden = def.secret && !got;
            const card = document.createElement("div");
            card.className = "cbadge-card" + (got ? " cbadge-earned" : " cbadge-locked");

            const medal = document.createElement("div");
            medal.className = "cbadge-medal " + (got ? `cbadge-tier-${def.tier}` : "cbadge-tier-locked");
            const medalText = document.createElement("span");
            medalText.className = "cbadge-medal-text";
            medalText.textContent = hidden ? "?" : def.medal;
            medal.appendChild(medalText);

            const name = document.createElement("div");
            name.className = "cbadge-name";
            name.textContent = hidden ? "Hidden" : def.name;

            let tip = hidden ? "A hidden achievement — keep exploring" : (def.desc || def.name);
            if (got) {
                try {
                    tip += " — earned " + new Date(got).toLocaleDateString(undefined, { month: "short", year: "numeric" });
                } catch (_) {}
            }
            card.setAttribute("title", tip);

            card.appendChild(medal);
            card.appendChild(name);
            row.appendChild(card);
        });
        grid.appendChild(row);
    });

    const section = document.getElementById("camp-badges-section");
    if (section) section.style.display = "";
}

// =========================================================================
// STYLES (injected once; toast used on both pages + dashboard grid)
// =========================================================================
let _styled = false;
function injectStyles() {
    if (_styled) return;
    _styled = true;
    const style = document.createElement("style");
    style.textContent = `
.cbadge-medal {
    position: relative; overflow: hidden;
    width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    border: 2.5px solid; flex: 0 0 auto;
}
.cbadge-medal-text { font-size: .78rem; font-weight: 800; letter-spacing: .02em; }
.cbadge-tier-bronze   { border-color: #b3763e; background: #faf3ec; color: #8a5a2e; }
.cbadge-tier-silver   { border-color: #94a3b3; background: #f4f6f8; color: #5c6b7a; }
.cbadge-tier-gold     { border-color: #d4af37; background: #fdf8e7; color: #a8842a; }
.cbadge-tier-platinum { border-color: #8fa6bd; background: #eef4fa; color: #51677d; box-shadow: 0 0 0 3px #eef4fa, 0 0 0 4.5px #c3d3e2; }
.cbadge-tier-accent   { border-color: #7c5cd4; background: #f5f3ff; color: #5b3fb8; }
.cbadge-tier-locked   { border-color: #d5dbe3; border-style: dashed; background: #f8fafc; color: #b0b9c4; }
.cbadge-medal::after {
    content: ""; position: absolute; top: -60%; left: -80%;
    width: 55%; height: 220%; transform: rotate(25deg);
    background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 100%);
    animation: cbadgeShine 3.2s ease-in-out infinite;
}
.cbadge-tier-locked::after { display: none; }

.cbadge-toast {
    position: fixed; top: 18px; right: 18px; z-index: 100000;
    display: flex; align-items: center; gap: 14px;
    width: min(340px, 92vw); padding: 14px 18px;
    background: #ffffff; color: #1e293b;
    border: 1px solid #e2e8f0; border-left: 3px solid #d4af37;
    border-radius: 12px;
    box-shadow: 0 10px 34px rgba(15, 23, 42, .16);
    animation: cbadgeIn .4s cubic-bezier(.25,1.2,.4,1);
}
.cbadge-toast.cbadge-out { opacity: 0; transform: translateX(24px); transition: opacity .35s ease, transform .35s ease; }
.cbadge-toast.cbadge-noanim { animation: none; }
.cbadge-toast.cbadge-noanim .cbadge-medal::after { display: none; }
.cbadge-toast-text { min-width: 0; }
.cbadge-toast-kicker { font-size: .66rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #a8842a; }
.cbadge-toast-name { margin-top: 2px; font-size: .98rem; font-weight: 700; color: #0f172a; }
.cbadge-toast-desc { margin-top: 1px; font-size: .78rem; color: #64748b; }
@keyframes cbadgeIn {
    0% { opacity: 0; transform: translateX(48px); }
    100% { opacity: 1; transform: translateX(0); }
}
@keyframes cbadgeShine {
    0%, 72% { left: -80%; }
    100% { left: 130%; }
}

.cbadge-cat {
    margin: 16px 0 8px; font-size: .68rem; font-weight: 700;
    letter-spacing: .12em; text-transform: uppercase; color: var(--slate-400, #94a3b8);
}
.cbadge-cat:first-child { margin-top: 0; }
.cbadge-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px;
}
.cbadge-card {
    display: flex; flex-direction: column; align-items: center; gap: 7px;
    padding: 12px 6px 10px; border-radius: 12px;
    border: 1px solid var(--slate-200, #e2e8f0); background: #fff;
    cursor: default;
}
.cbadge-card.cbadge-locked .cbadge-name { color: var(--slate-400, #94a3b8); }
.cbadge-name { font-size: .74rem; font-weight: 600; color: var(--slate-700, #334155); text-align: center; line-height: 1.25; }
`;
    document.head.appendChild(style);
}

// =========================================================================
// BOOT
// =========================================================================
async function boot() {
    if (window.__campBadges === false) return;
    const onDashboard = !!document.getElementById("campBadgesGrid");

    if (onDashboard) {
        if (!(await ensureInit())) return;
        renderIfPresent();                       // show collection immediately
        await evaluate();                        // then check for new awards
        renderIfPresent();
    } else {
        // Flow (or any page firing generation events): evaluate after each
        // successful generation + once shortly after boot (retroactive catch-up).
        document.addEventListener("campistry-schedule-generated", () => {
            setTimeout(() => { evaluate().catch(() => {}); }, 2000);
        });
        setTimeout(() => { evaluate().catch(() => {}); }, 8000);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}

window.CampBadges = { award, evaluate, defs: BADGE_DEFS };

})();
