// ============================================================================
// badges.js — CAMP ACHIEVEMENTS v3.1
// ============================================================================
// Per-camp achievements, displayed on the dashboard and awarded live.
//
// Categories:
//   Milestones  — daily schedules generated (1 / 10 / 50 / 100)
//   Years       — tenure with Campistry (camps.created_at)
//   Enrollment  — campers enrolled (camperRoster count, else bunkMetaData sizes)
//   Special     — Founding Member (camps.plan_status === 'founding_member')
//   Secret      — the easter egg (awarded by easter_egg.js via CampBadges.award)
//
// Presentation: metallic medallions — conic-gradient metal ring (bronze/
// silver/gold/platinum, rose-gold founder, violet secret) around a dark coin
// face with a periodic shine sweep and tier glow. Earned medals also render
// in the dashboard HERO next to the camp name (#dashHeroBadges) — the strip
// is content-sized so it never squeezes the camp name (v3.1: the v3 strip
// grabbed flex space and wrapped long names), 30px medals capped at the 6
// most recent, plus a count chip that scrolls to the full collection at the
// bottom of the page. Badge IDs are unchanged — earned cloud data carries
// over. No SQL migrations anywhere: state lives in the existing
// camp_state_kv table; founder status reads the existing camps.plan_status.
//
// Storage: camp_state_kv key 'campBadges' → { earned: { badgeId: isoDate } }
// (direct Supabase upsert with read-merge-union so badges are never lost to a
// stale cache; localStorage mirror per camp for resilience). Badges only ever
// accumulate — merge = union with earliest timestamp.
//
// Runs on BOTH pages:
//   dashboard.html — hero strip + collection in #campBadgesGrid + evaluates
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
    // Special — founding camps (camps.plan_status === 'founding_member')
    { id: "founding_member",medal: "✦",  tier: "rose",     name: "Founding Member", cat: "Special", desc: "One of Campistry's founding camps", check: s => s.foundingMember === true },
    // Secret — event-awarded only (no check)
    { id: "egg_hunter",     medal: "★",  tier: "accent",   name: "Easter Egg",  cat: "Secret", desc: "Discovered the hidden easter egg", secret: true },
];

const CATEGORY_ORDER = ["Milestones", "Years with Campistry", "Enrollment", "Special", "Secret"];
const HERO_MAX_MEDALS = 6;   // hero strip shows the N most recent; chip carries the full count

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

    // -- years with the program + founding-member plan (camps row; may be
    //    RLS-blocked for scheduler-role users → these just don't evaluate
    //    on that client, the owner's dashboard visit awards them) --
    try {
        const { data, error } = await window.supabase
            .from("camps")
            .select("created_at, plan_status")
            .eq("id", campId);
        const row = !error && data && data[0];
        if (row && row.created_at) {
            const ms = Date.now() - new Date(row.created_at).getTime();
            if (ms >= 0) stats.years = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
        }
        if (row && row.plan_status) {
            stats.foundingMember = String(row.plan_status) === "founding_member";
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
// MEDALLION BUILDER (shared by hero strip, collection grid, toast)
// =========================================================================
function buildMedal(def, opts) {
    const locked = !!(opts && opts.locked);
    const hidden = !!(opts && opts.hidden);
    const medal = document.createElement("div");
    medal.className = "cbadge-medal " + (locked ? "cbadge-tier-locked" : `cbadge-tier-${def.tier}`);
    const face = document.createElement("span");
    face.className = "cbadge-medal-face";
    const text = document.createElement("span");
    text.className = "cbadge-medal-text";
    text.textContent = hidden ? "?" : def.medal;
    face.appendChild(text);
    medal.appendChild(face);
    return medal;
}

// =========================================================================
// AWARD TOAST (queued, sequential)
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
    toast.appendChild(buildMedal(def));
    const textWrap = document.createElement("div");
    textWrap.className = "cbadge-toast-text";
    textWrap.innerHTML = [
        '<div class="cbadge-toast-kicker">Achievement unlocked</div>',
        '<div class="cbadge-toast-name"></div>',
        '<div class="cbadge-toast-desc"></div>',
    ].join("");
    textWrap.querySelector(".cbadge-toast-name").textContent = def.name;
    textWrap.querySelector(".cbadge-toast-desc").textContent = def.desc || "";
    toast.appendChild(textWrap);
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
// RENDER — HERO STRIP (earned medals by the camp name) + COLLECTION GRID
// =========================================================================
function renderIfPresent() {
    if (!_state) return;
    const grid = document.getElementById("campBadgesGrid");
    if (grid) renderCollection(grid);
    const strip = document.getElementById("dashHeroBadges");
    if (strip) renderHeroStrip(strip);
}

function renderHeroStrip(strip) {
    injectStyles();
    const earned = (_state && _state.earned) || {};
    let earnedDefs = BADGE_DEFS.filter(d => earned[d.id]);
    const totalEarned = earnedDefs.length;

    // Keep the strip compact: show only the most recently earned medals
    // (definition order preserved); the chip carries the full count.
    if (earnedDefs.length > HERO_MAX_MEDALS) {
        const byRecent = [...earnedDefs].sort((a, b) => String(earned[b.id]).localeCompare(String(earned[a.id])));
        const keep = new Set(byRecent.slice(0, HERO_MAX_MEDALS).map(d => d.id));
        earnedDefs = earnedDefs.filter(d => keep.has(d.id));
    }

    strip.innerHTML = "";
    earnedDefs.forEach(def => {
        const medal = buildMedal(def);
        medal.setAttribute("title", def.name + " — " + (def.desc || ""));
        strip.appendChild(medal);
    });

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cbadge-hero-chip";
    chip.textContent = `${totalEarned} of ${BADGE_DEFS.length}`;
    chip.setAttribute("title", "View all achievements");
    chip.addEventListener("click", () => {
        const section = document.getElementById("camp-badges-section");
        if (section && section.scrollIntoView) section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    strip.appendChild(chip);
    strip.style.display = "";
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

            card.appendChild(buildMedal(def, { locked: !got, hidden }));
            card.appendChild(name);
            row.appendChild(card);
        });
        grid.appendChild(row);
    });

    const section = document.getElementById("camp-badges-section");
    if (section) section.style.display = "";
}

// =========================================================================
// STYLES (injected once; shared by hero strip, grid, toast on both pages)
// =========================================================================
let _styled = false;
function injectStyles() {
    if (_styled) return;
    _styled = true;
    const style = document.createElement("style");
    style.textContent = `
.cbadge-medal {
    position: relative; overflow: hidden;
    width: 48px; height: 48px; border-radius: 50%;
    padding: 3px; flex: 0 0 auto;
    display: flex;
}
.cbadge-medal-face {
    flex: 1; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 32% 28%, #2a3560 0%, #161d3d 58%, #0e1330 100%);
}
.cbadge-medal-text { font-size: .76rem; font-weight: 800; letter-spacing: .02em; }
.cbadge-tier-bronze   { background: conic-gradient(from 210deg, #8a5a2e, #e0a06a, #6f4522, #f0c395, #8a5a2e); box-shadow: 0 2px 12px rgba(200,130,70,.45); }
.cbadge-tier-bronze   .cbadge-medal-text { color: #eab585; }
.cbadge-tier-silver   { background: conic-gradient(from 210deg, #6e7d8c, #e8eff5, #5d6c7b, #ffffff, #6e7d8c); box-shadow: 0 2px 12px rgba(150,170,190,.5); }
.cbadge-tier-silver   .cbadge-medal-text { color: #dde6ee; }
.cbadge-tier-gold     { background: conic-gradient(from 210deg, #8f6b1d, #f9e076, #7a5a14, #fff3ae, #8f6b1d); box-shadow: 0 2px 14px rgba(220,180,60,.55); }
.cbadge-tier-gold     .cbadge-medal-text { color: #f7dd7a; }
.cbadge-tier-platinum { background: conic-gradient(from 210deg, #47596e, #d9e9f8, #3c4c5f, #f2faff, #47596e); box-shadow: 0 2px 16px rgba(150,195,235,.6), 0 0 0 1.5px rgba(210,230,250,.45); }
.cbadge-tier-platinum .cbadge-medal-text { color: #d9e9f8; }
.cbadge-tier-accent   { background: conic-gradient(from 210deg, #4c2fa8, #b49bfc, #3d2494, #d4c6ff, #4c2fa8); box-shadow: 0 2px 14px rgba(140,100,250,.55); }
.cbadge-tier-accent   .cbadge-medal-text { color: #c3b0fd; }
.cbadge-tier-rose     { background: conic-gradient(from 210deg, #8f4a3e, #f2b09b, #7a3a30, #ffd3c0, #8f4a3e); box-shadow: 0 2px 14px rgba(235,145,115,.55); }
.cbadge-tier-rose     .cbadge-medal-text { color: #f4b8a4; }
.cbadge-medal::after {
    content: ""; position: absolute; top: -60%; left: -80%;
    width: 55%; height: 220%; transform: rotate(25deg);
    background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.5) 50%, rgba(255,255,255,0) 100%);
    animation: cbadgeShine 3.6s ease-in-out infinite;
}
.cbadge-tier-locked { background: repeating-conic-gradient(#dfe5ec 0deg 14deg, #f2f5f8 14deg 28deg); box-shadow: none; }
.cbadge-tier-locked .cbadge-medal-face { background: #f8fafc; }
.cbadge-tier-locked .cbadge-medal-text { color: #b0b9c4; }
.cbadge-tier-locked::after { display: none; }
@keyframes cbadgeShine {
    0%, 76% { left: -80%; }
    100% { left: 140%; }
}

/* Hero strip — sits between the camp name and the clock/weather widgets.
   Content-sized (flex: 0 1 auto) so it NEVER steals width from the camp
   name; .dash-hero-left keeps its flex:1 and the hero keeps its original
   height. Capped at HERO_MAX_MEDALS small medals; narrower screens trim
   medals via the nth-of-type rules below, phones hide the strip. */
.dash-hero-badges {
    position: relative; z-index: 1;
    display: flex; flex-wrap: nowrap; align-items: center;
    gap: 8px; flex: 0 1 auto; min-width: 0; margin: 0 16px;
}
.dash-hero-badges .cbadge-medal { width: 30px; height: 30px; padding: 2px; }
.dash-hero-badges .cbadge-medal-text { font-size: .54rem; }
.cbadge-hero-chip {
    padding: 5px 10px; border-radius: 999px;
    background: rgba(255,255,255,.14); color: #eef6f6;
    border: 1px solid rgba(255,255,255,.28);
    font-size: .66rem; font-weight: 700; letter-spacing: .04em;
    white-space: nowrap;
    cursor: pointer; transition: background .15s ease;
}
.cbadge-hero-chip:hover { background: rgba(255,255,255,.24); }
@media (max-width: 1200px) { .dash-hero-badges .cbadge-medal:nth-of-type(n+5) { display: none; } }
@media (max-width: 1000px) { .dash-hero-badges .cbadge-medal:nth-of-type(n+3) { display: none; } }
@media (max-width: 760px)  { .dash-hero-badges { display: none !important; } }

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
        renderIfPresent();                       // show hero strip + collection immediately
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
