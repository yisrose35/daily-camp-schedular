// ============================================================================
// easter_egg.js — CAMPISTRY EASTER EGG v2.0
// ============================================================================
// Purely cosmetic. Two hidden triggers, one celebration:
//   1. Click the Flow logo in the header 7 times quickly
//   2. The Konami code (↑ ↑ ↓ ↓ ← → ← → B A) anywhere outside a text field
// Fires a fireworks + confetti show and an "achievement unlocked" card with
// a contact-us button (mailto). Dismiss via button, backdrop, Esc, or 25s.
// Touches NO scheduling logic, NO data, NO cloud — display only.
// Kill switch: window.__campistryEasterEgg = false
// ============================================================================
(function(){
'use strict';

const LOGO_CLICKS_NEEDED = 7;
const LOGO_CLICK_WINDOW_MS = 1500;   // max gap between consecutive clicks
const AUTO_DISMISS_MS = 25000;
const CONTACT_EMAIL = "campistryoffice@gmail.com";

const TAGLINES = [
    "🏕️ Secret campfire status: unlocked.",
    "🎉 COLOR WAR BREAKOUT!!!",
    "🍫 You've earned a s'more. Go get one.",
    "📣 Announcements, announcements, annOUNCEments!",
    "🛶 Legend says only the best head counselors find this.",
    "🌟 Best. Scheduler. Ever. Pass it on.",
];

const FIREWORK_COLORS = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#5f27cd", "#ff9ff3", "#ffa502", "#ffd700", "#7bed9f"];

let running = false;

// =========================================================================
// TRIGGER 1: rapid clicks on the Flow logo
// =========================================================================
let clickCount = 0;
let lastClickAt = 0;

function watchLogo() {
    const logo = document.querySelector(".quick-switch-active");
    if (!logo) return;
    logo.addEventListener("click", () => {
        const now = Date.now();
        clickCount = (now - lastClickAt <= LOGO_CLICK_WINDOW_MS) ? clickCount + 1 : 1;
        lastClickAt = now;
        if (clickCount >= LOGO_CLICKS_NEEDED) {
            clickCount = 0;
            celebrate();
        }
    });
}

// =========================================================================
// TRIGGER 2: Konami code
// =========================================================================
const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
let konamiPos = 0;

function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) { konamiPos = 0; return; }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === KONAMI[konamiPos]) {
        konamiPos++;
        if (konamiPos === KONAMI.length) {
            konamiPos = 0;
            celebrate();
        }
    } else {
        konamiPos = (key === KONAMI[0]) ? 1 : 0;
    }
});

// =========================================================================
// CELEBRATION
// =========================================================================
function celebrate() {
    if (window.__campistryEasterEgg === false) return;
    if (running) return;
    running = true;

    // Finding the egg earns the camp its secret badge (badges.js)
    try { window.CampBadges && window.CampBadges.award("egg_hunter"); } catch (_) {}

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const style = buildStyle();
    document.head.appendChild(style);

    const backdrop = document.createElement("div");
    backdrop.className = "cegg-backdrop";
    document.body.appendChild(backdrop);

    let canvas = null;
    let stopShow = null;
    if (!reducedMotion) {
        canvas = document.createElement("canvas");
        canvas.className = "cegg-canvas";
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        document.body.appendChild(canvas);
        stopShow = runFireworks(canvas);
    }

    const card = buildCard(reducedMotion);
    document.body.appendChild(card);

    let dismissed = false;
    const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); cleanup(); } };
    const cleanup = () => {
        if (dismissed) return;
        dismissed = true;
        if (stopShow) stopShow();
        backdrop.remove();
        if (canvas) canvas.remove();
        card.remove();
        style.remove();
        document.removeEventListener("keydown", onEsc, true);
        running = false;
    };

    backdrop.addEventListener("click", cleanup);
    card.querySelector(".cegg-dismiss").addEventListener("click", cleanup);
    document.addEventListener("keydown", onEsc, true);
    setTimeout(cleanup, AUTO_DISMISS_MS);
}

// =========================================================================
// ACHIEVEMENT CARD
// =========================================================================
function buildCard(reducedMotion) {
    const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
    const subject = encodeURIComponent("I found the Campistry easter egg! 🥚");
    const body = encodeURIComponent("Hi Campistry team!\n\nI discovered the hidden celebration in Campistry Flow. 🎆\n\n— Sent from the secret campfire");

    const card = document.createElement("div");
    card.className = "cegg-card" + (reducedMotion ? " cegg-noanim" : "");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "You found the easter egg");
    card.innerHTML = [
        '<div class="cegg-egg">🥚</div>',
        '<div class="cegg-kicker">✨ ACHIEVEMENT UNLOCKED ✨</div>',
        '<div class="cegg-title">You found the easter egg!</div>',
        '<div class="cegg-tagline"></div>',
        '<div class="cegg-sub">You\'re one of the very few who\'ve ever seen this.<br>Contact us and let us know — we\'d love to hear from you!</div>',
        '<div class="cegg-actions">',
        `  <a class="cegg-contact" href="mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}">📣 Tell us you found it</a>`,
        '  <button type="button" class="cegg-dismiss">🤫 Keep it secret</button>',
        '</div>',
    ].join("");
    card.querySelector(".cegg-tagline").textContent = tagline;
    card.addEventListener("click", (e) => e.stopPropagation());
    return card;
}

function buildStyle() {
    const style = document.createElement("style");
    style.textContent = `
.cegg-backdrop {
    position: fixed; inset: 0; z-index: 99997;
    background: radial-gradient(ellipse at center, rgba(10,14,35,0.55) 0%, rgba(5,7,20,0.82) 100%);
    animation: ceggFade .4s ease;
}
.cegg-canvas { position: fixed; inset: 0; z-index: 99998; pointer-events: none; }
.cegg-card {
    position: fixed; top: 50%; left: 50%; z-index: 99999;
    transform: translate(-50%, -50%);
    width: min(440px, 92vw);
    padding: 34px 30px 28px;
    text-align: center;
    color: #fff;
    background: linear-gradient(160deg, #1b2148 0%, #131735 55%, #1f1440 100%);
    border-radius: 22px;
    box-shadow: 0 0 0 2px rgba(255,215,0,.65), 0 0 42px rgba(255,215,0,.30), 0 24px 70px rgba(0,0,0,.55);
    animation: ceggPop .55s cubic-bezier(.2,1.6,.35,1);
    font-family: inherit;
}
.cegg-egg {
    font-size: 58px; line-height: 1;
    filter: drop-shadow(0 0 14px rgba(255,215,0,.75));
    animation: ceggWobble 2.2s ease-in-out infinite;
}
.cegg-kicker {
    margin-top: 12px;
    font-size: .78rem; font-weight: 800; letter-spacing: .22em;
    background: linear-gradient(90deg, #ffd700, #fff3b0, #ffd700);
    background-size: 200% auto;
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
    animation: ceggShimmer 2.4s linear infinite;
}
.cegg-title { margin-top: 8px; font-size: 1.65rem; font-weight: 800; }
.cegg-tagline { margin-top: 10px; font-size: 1.02rem; font-weight: 600; color: #ffe27a; }
.cegg-sub { margin-top: 12px; font-size: .95rem; line-height: 1.5; color: #cdd3f2; }
.cegg-actions {
    margin-top: 22px;
    display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;
}
.cegg-contact {
    display: inline-block; padding: 12px 22px;
    background: linear-gradient(135deg, #ffd700, #ff9f1a);
    color: #22160a; font-weight: 800; font-size: .98rem;
    border-radius: 999px; text-decoration: none;
    box-shadow: 0 6px 20px rgba(255,170,0,.45);
    transition: transform .15s ease, box-shadow .15s ease;
}
.cegg-contact:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 10px 26px rgba(255,170,0,.6); color: #22160a; }
.cegg-dismiss {
    padding: 12px 20px;
    background: rgba(255,255,255,.10);
    color: #dfe4ff; font-weight: 700; font-size: .95rem;
    border: 1px solid rgba(255,255,255,.22);
    border-radius: 999px; cursor: pointer;
    transition: background .15s ease;
}
.cegg-dismiss:hover { background: rgba(255,255,255,.18); }
.cegg-noanim, .cegg-noanim .cegg-egg, .cegg-noanim .cegg-kicker { animation: none; }
@keyframes ceggFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ceggPop {
    0% { transform: translate(-50%, -50%) scale(.4) rotate(-6deg); opacity: 0; }
    100% { transform: translate(-50%, -50%) scale(1) rotate(0deg); opacity: 1; }
}
@keyframes ceggWobble {
    0%, 100% { transform: rotate(-7deg) translateY(0); }
    50% { transform: rotate(7deg) translateY(-6px); }
}
@keyframes ceggShimmer { to { background-position: 200% center; } }
`;
    return style;
}

// =========================================================================
// FIREWORKS + CONFETTI SHOW
// =========================================================================
function runFireworks(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const particles = [];   // firework sparks
    const streamers = [];   // falling confetti

    function spawnBurst(x, y) {
        const color = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
        const color2 = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
        const count = 60 + Math.floor(Math.random() * 40);
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + Math.random() * 0.1;
            const speed = 2 + Math.random() * 5.5;
            particles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                decay: 0.012 + Math.random() * 0.012,
                size: 1.6 + Math.random() * 2.2,
                color: Math.random() < 0.5 ? color : color2,
            });
        }
    }

    function spawnStreamer() {
        streamers.push({
            x: Math.random() * W,
            y: -12,
            vy: 1.6 + Math.random() * 2.4,
            sway: Math.random() * Math.PI * 2,
            swaySpeed: 0.03 + Math.random() * 0.05,
            size: 5 + Math.random() * 6,
            rot: Math.random() * Math.PI * 2,
            vr: (Math.random() - 0.5) * 0.25,
            color: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
        });
    }

    // opening salvo, then a burst every ~650ms + steady confetti
    spawnBurst(W * 0.5, H * 0.35);
    spawnBurst(W * 0.25, H * 0.3);
    spawnBurst(W * 0.75, H * 0.3);
    const burstTimer = setInterval(() => {
        spawnBurst(W * (0.12 + Math.random() * 0.76), H * (0.12 + Math.random() * 0.45));
    }, 650);
    const streamTimer = setInterval(() => {
        for (let i = 0; i < 3; i++) spawnStreamer();
    }, 90);

    let rafId = null;
    function frame() {
        ctx.clearRect(0, 0, W, H);

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.vy += 0.045;          // gravity
            p.vx *= 0.985;          // drag
            p.vy *= 0.985;
            p.x += p.vx;
            p.y += p.vy;
            p.life -= p.decay;
            if (p.life <= 0) { particles.splice(i, 1); continue; }
            ctx.globalAlpha = Math.max(0, p.life) * (0.75 + Math.random() * 0.25); // twinkle
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalAlpha = 1;
        for (let i = streamers.length - 1; i >= 0; i--) {
            const s = streamers[i];
            s.sway += s.swaySpeed;
            s.x += Math.sin(s.sway) * 1.4;
            s.y += s.vy;
            s.rot += s.vr;
            if (s.y > H + 20) { streamers.splice(i, 1); continue; }
            ctx.save();
            ctx.translate(s.x, s.y);
            ctx.rotate(s.rot);
            ctx.fillStyle = s.color;
            ctx.fillRect(-s.size / 2, -s.size / 2, s.size, s.size * 0.6);
            ctx.restore();
        }

        rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return () => {
        clearInterval(burstTimer);
        clearInterval(streamTimer);
        if (rafId) cancelAnimationFrame(rafId);
    };
}

// =========================================================================
// INIT
// =========================================================================
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchLogo);
} else {
    watchLogo();
}

})();
