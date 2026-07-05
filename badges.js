// ============================================================================
// badges.js — CAMP BADGES / ACHIEVEMENTS v1.0
// ============================================================================
// Per-camp achievement badges, displayed on the dashboard and awarded live.
//
// Categories:
//   Milestones  — daily schedules generated (1 / 10 / 50 / 100)
//   Years       — tenure with Campistry (camps.created_at)
//   Enrollment  — campers enrolled (camperRoster count, else bunkMetaData sizes)
//   Secret      — the easter egg (awarded by easter_egg.js via CampBadges.award)
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
// Award moment: sliding toast + mini confetti burst (queued; >3 at once
// collapses into a summary toast). Kill switch: window.__campBadges = false
// ============================================================================
(function(){
'use strict';

const KV_KEY = "campBadges";
const LOCAL_MIRROR_PREFIX = "campistry_badges_v1:";
const TOAST_MS = 3400;

// =========================================================================
// BADGE DEFINITIONS
// =========================================================================
// check(stats) — stats fields may be undefined when unknown; comparisons
// against undefined are false, so badges never award on missing data.
const BADGE_DEFS = [
    // Milestones — schedules generated
    { id: "first_schedule", icon: "🗓️", name: "First Light",      cat: "Milestones", desc: "Generate your first daily schedule",  check: s => s.schedules >= 1 },
    { id: "schedules_10",   icon: "📅", name: "Getting Rolling",  cat: "Milestones", desc: "Generate 10 daily schedules",          check: s => s.schedules >= 10 },
    { id: "schedules_50",   icon: "🏗️", name: "Schedule Machine", cat: "Milestones", desc: "Generate 50 daily schedules",          check: s => s.schedules >= 50 },
    { id: "schedules_100",  icon: "💯", name: "Century Club",     cat: "Milestones", desc: "Generate 100 daily schedules",         check: s => s.schedules >= 100 },
    // Years with Campistry
    { id: "rookie_season",  icon: "🌱", name: "Rookie Season",    cat: "Years with Campistry", desc: "Welcome to Campistry!",       check: s => s.years >= 0 },
    { id: "second_summer",  icon: "🥈", name: "Second Summer",    cat: "Years with Campistry", desc: "One year with Campistry",     check: s => s.years >= 1 },
    { id: "camp_veteran",   icon: "🏕️", name: "Camp Veteran",     cat: "Years with Campistry", desc: "Three years with Campistry",  check: s => s.years >= 3 },
    { id: "founding_legend",icon: "🏛️", name: "Founding Legend",  cat: "Years with Campistry", desc: "Five years with Campistry",   check: s => s.years >= 5 },
    // Enrollment
    { id: "campers_50",     icon: "🐣", name: "Cozy Camp",        cat: "Enrollment", desc: "50+ campers enrolled",   check: s => s.campers >= 50 },
    { id: "campers_100",    icon: "🚌", name: "Growing Strong",   cat: "Enrollment", desc: "100+ campers enrolled",  check: s => s.campers >= 100 },
    { id: "campers_250",    icon: "🎪", name: "Big League",       cat: "Enrollment", desc: "250+ campers enrolled",  check: s => s.campers >= 250 },
    { id: "campers_500",    icon: "🌆", name: "Mega Camp",        cat: "Enrollment", desc: "500+ campers enrolled",  check: s => s.campers >= 500 },
    // Secret — event-awarded only (no check)
    { id: "egg_hunter",     icon: "🥚", name: "Egg Hunter",       cat: "Secret", desc: "Found the hidden easter egg", secret: true },
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
// AWARD TOAST + MINI CONFETTI (queued, sequential)
// =========================================================================
const _toastQueue = [];
let _toastActive = false;

function queueToast(defs) {
    // >3 at once (e.g. retroactive first run): show 2, collapse the rest
    if (defs.length > 3) {
        _toastQueue.push(defs[0], defs[1], {
            icon: "🎖️", name: `+${defs.length - 2} more badges earned!`,
            cat: "See your collection on the Dashboard", _summary: true,
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
        '<canvas class="cbadge-burst" width="300" height="150"></canvas>',
        '<div class="cbadge-toast-icon"></div>',
        '<div class="cbadge-toast-text">',
        '  <div class="cbadge-toast-kicker">🏅 BADGE EARNED</div>',
        '  <div class="cbadge-toast-name"></div>',
        '  <div class="cbadge-toast-cat"></div>',
        '</div>',
    ].join("");
    toast.querySelector(".cbadge-toast-icon").textContent = def.icon;
    toast.querySelector(".cbadge-toast-name").textContent = def.name;
    toast.querySelector(".cbadge-toast-cat").textContent = def._summary ? def.cat : (def.desc || def.cat);
    document.body.appendChild(toast);

    let stopBurst = null;
    if (!reducedMotion) stopBurst = runMiniBurst(toast.querySelector(".cbadge-burst"));

    setTimeout(() => {
        toast.classList.add("cbadge-out");
        setTimeout(() => {
            if (stopBurst) stopBurst();
            toast.remove();
            _toastActive = false;
            pumpToasts();
        }, 350);
    }, TOAST_MS);
}

function runMiniBurst(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const colors = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ffd700", "#ff9ff3"];
    const parts = [];
    for (let i = 0; i < 45; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.5 + Math.random() * 3.5;
        parts.push({
            x: W * 0.22, y: H * 0.5,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1,
            life: 1, decay: 0.015 + Math.random() * 0.02,
            size: 2 + Math.random() * 3,
            color: colors[i % colors.length],
        });
    }
    let rafId = null;
    function frame() {
        ctx.clearRect(0, 0, W, H);
        let alive = 0;
        for (const p of parts) {
            if (p.life <= 0) continue;
            alive++;
            p.vy += 0.06;
            p.x += p.vx; p.y += p.vy;
            p.life -= p.decay;
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x, p.y, p.size, p.size * 0.7);
        }
        ctx.globalAlpha = 1;
        if (alive > 0) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
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
    if (counter) counter.textContent = `${earnedCount} / ${BADGE_DEFS.length} earned`;

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
            const icon = document.createElement("div");
            icon.className = "cbadge-icon";
            icon.textContent = hidden ? "❓" : def.icon;
            const name = document.createElement("div");
            name.className = "cbadge-name";
            name.textContent = hidden ? "???" : def.name;
            const desc = document.createElement("div");
            desc.className = "cbadge-desc";
            desc.textContent = hidden ? "A hidden secret… keep exploring." : def.desc;
            card.appendChild(icon); card.appendChild(name); card.appendChild(desc);
            if (got) {
                const when = document.createElement("div");
                when.className = "cbadge-date";
                try {
                    when.textContent = "Earned " + new Date(got).toLocaleDateString(undefined, { month: "short", year: "numeric" });
                } catch (_) { when.textContent = "Earned"; }
                card.appendChild(when);
            }
            row.appendChild(card);
        });
        grid.appendChild(row);
    });

    const section = document.getElementById("camp-badges-section");
    if (section) section.style.display = "";
}

// =========================================================================
// STYLES (injected once; used by toast on both pages + dashboard grid)
// =========================================================================
let _styled = false;
function injectStyles() {
    if (_styled) return;
    _styled = true;
    const style = document.createElement("style");
    style.textContent = `
.cbadge-toast {
    position: fixed; top: 18px; right: 18px; z-index: 100000;
    display: flex; align-items: center; gap: 14px;
    width: min(340px, 92vw); padding: 14px 18px;
    background: linear-gradient(160deg, #1b2148 0%, #131735 60%, #1f1440 100%);
    color: #fff; border-radius: 16px;
    box-shadow: 0 0 0 2px rgba(255,215,0,.6), 0 0 26px rgba(255,215,0,.25), 0 14px 40px rgba(0,0,0,.4);
    animation: cbadgeIn .45s cubic-bezier(.2,1.5,.4,1);
    overflow: hidden;
}
.cbadge-toast.cbadge-out { opacity: 0; transform: translateX(30px); transition: opacity .35s ease, transform .35s ease; }
.cbadge-toast.cbadge-noanim { animation: none; }
.cbadge-burst { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.cbadge-toast-icon { font-size: 38px; line-height: 1; filter: drop-shadow(0 0 8px rgba(255,215,0,.6)); z-index: 1; }
.cbadge-toast-text { z-index: 1; min-width: 0; }
.cbadge-toast-kicker { font-size: .68rem; font-weight: 800; letter-spacing: .16em; color: #ffd700; }
.cbadge-toast-name { margin-top: 2px; font-size: 1.02rem; font-weight: 800; }
.cbadge-toast-cat { margin-top: 2px; font-size: .78rem; color: #cdd3f2; }
@keyframes cbadgeIn {
    0% { opacity: 0; transform: translateX(60px) scale(.85); }
    100% { opacity: 1; transform: translateX(0) scale(1); }
}
.cbadge-cat {
    margin: 18px 0 10px; font-size: .72rem; font-weight: 800;
    letter-spacing: .14em; text-transform: uppercase; color: var(--slate-400, #94a3b8);
}
.cbadge-cat:first-child { margin-top: 0; }
.cbadge-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
}
.cbadge-card {
    position: relative; text-align: center;
    padding: 16px 10px 14px; border-radius: 14px;
    border: 1px solid var(--slate-200, #e2e8f0); background: #fff;
}
.cbadge-card.cbadge-earned {
    border: 2px solid #ffd700;
    background: linear-gradient(180deg, #fffdf2 0%, #fff8dc 100%);
    box-shadow: 0 4px 14px rgba(255,190,0,.18);
}
.cbadge-card.cbadge-locked { opacity: .55; filter: grayscale(1); }
.cbadge-icon { font-size: 34px; line-height: 1; }
.cbadge-earned .cbadge-icon { filter: drop-shadow(0 0 6px rgba(255,200,0,.55)); }
.cbadge-name { margin-top: 8px; font-size: .88rem; font-weight: 700; color: var(--slate-800, #1e293b); }
.cbadge-desc { margin-top: 4px; font-size: .72rem; line-height: 1.35; color: var(--slate-500, #64748b); }
.cbadge-date { margin-top: 6px; font-size: .68rem; font-weight: 700; color: #b8860b; }
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
