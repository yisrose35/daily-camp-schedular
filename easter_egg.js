// ============================================================================
// easter_egg.js — CAMPISTRY EASTER EGG v1.0
// ============================================================================
// Purely cosmetic. Two hidden triggers, one celebration:
//   1. Click the Flow logo in the header 7 times quickly
//   2. The Konami code (↑ ↑ ↓ ↓ ← → ← → B A) anywhere outside a text field
// Fires a confetti burst + a camp-themed message, then cleans itself up.
// Touches NO scheduling logic, NO data, NO cloud — display only.
// Kill switch: window.__campistryEasterEgg = false
// ============================================================================
(function(){
'use strict';

const LOGO_CLICKS_NEEDED = 7;
const LOGO_CLICK_WINDOW_MS = 1500;   // max gap between consecutive clicks
const SHOW_MS = 4500;

const MESSAGES = [
    "🏕️ You found the secret campfire!",
    "🎉 COLOR WAR BREAKOUT!!!",
    "🍫 You've earned a s'more. Go get one.",
    "📣 Announcements, announcements, annOUNCEments!",
    "🛶 Free swim for everyone! (schedule not affected)",
    "🌟 Best. Scheduler. Ever. Pass it on.",
    "🦟 May your days be sunny and your bunks be even.",
];

const CONFETTI_COLORS = ["#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#5f27cd", "#ff9ff3", "#ffa502"];

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

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

    const toast = buildToast(message);
    document.body.appendChild(toast);

    let canvas = null;
    let stopConfetti = null;
    if (!reducedMotion) {
        canvas = buildCanvas();
        document.body.appendChild(canvas);
        stopConfetti = runConfetti(canvas);
    }

    const cleanup = () => {
        if (stopConfetti) stopConfetti();
        if (canvas) canvas.remove();
        toast.remove();
        running = false;
    };
    toast.addEventListener("click", cleanup);
    setTimeout(cleanup, SHOW_MS);
}

function buildToast(message) {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("role", "status");
    toast.style.cssText = [
        "position:fixed", "top:18%", "left:50%", "transform:translateX(-50%) scale(0.8)",
        "background:rgba(20,24,40,0.92)", "color:#fff", "padding:16px 28px",
        "border-radius:14px", "font-size:1.25rem", "font-weight:700",
        "box-shadow:0 8px 32px rgba(0,0,0,0.35)", "z-index:99999",
        "cursor:pointer", "opacity:0", "transition:opacity .25s ease, transform .25s ease",
        "max-width:90vw", "text-align:center",
    ].join(";");
    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateX(-50%) scale(1)";
    });
    return toast;
}

function buildCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:99998;";
    return canvas;
}

function runConfetti(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pieces = [];
    for (let i = 0; i < 160; i++) {
        const angle = (Math.random() * Math.PI) - Math.PI;       // upward fan
        const speed = 6 + Math.random() * 9;
        pieces.push({
            x: W / 2 + (Math.random() - 0.5) * 80,
            y: H * 0.55,
            vx: Math.cos(angle) * speed * (Math.random() < 0.5 ? 1 : -1),
            vy: Math.sin(angle) * speed - 4,
            size: 5 + Math.random() * 6,
            color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            rot: Math.random() * Math.PI * 2,
            vr: (Math.random() - 0.5) * 0.3,
        });
    }
    let rafId = null;
    function frame() {
        ctx.clearRect(0, 0, W, H);
        let alive = 0;
        for (const p of pieces) {
            p.vy += 0.25;                 // gravity
            p.vx *= 0.99;
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.vr;
            if (p.y < H + 20) alive++;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
            ctx.restore();
        }
        if (alive > 0) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
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
