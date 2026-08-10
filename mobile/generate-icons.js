// Generates every app icon and splash image for both Campistry mobile apps
// from vector art, so each size is rendered crisply rather than resampled from
// a bitmap. Run from mobile/: `node generate-icons.js`
//
// Why vector: the only copy of the Campistry mark in the repo is a 30x43 PNG.
// An app icon needs 1024x1024 — a 34x upscale of that is mush, and the icon is
// the most-looked-at piece of branding either app has. So the tent is rebuilt
// here as SVG paths (checked against the original silhouette at ~97% of pixels;
// the rest is the original's antialiasing) and rendered fresh at every size.
//
// Both apps use the same mark on their own brand colour:
//   Lite — coral  #EE6A53   (matches manifest_lite.webmanifest theme_color)
//   Link — green  #166534   (matches campistry_link.webmanifest theme_color)
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('./campistry-lite/node_modules/sharp');

// ── The mark, in the source PNG's own 30x43 coordinate space ────────────────
const W = 30, H = 43;
const CX = 14.5, BASE_Y = 34, HALF_BASE = 14.5;
const BODY_APEX_Y = 9.0;      // apex sits BELOW where the poles cross, as in the original
const DOOR_APEX_Y = 22, DOOR_HALF = 4.8;
const POLE_TOP_Y = 4.6, POLE_SPREAD = 3.0, POLE_W = 1.9, POLE_BOTTOM_Y = 12.6;

const BODY_PATH =
    `M ${CX} ${BODY_APEX_Y} L ${CX + HALF_BASE} ${BASE_Y} L ${CX - HALF_BASE} ${BASE_Y} Z ` +
    `M ${CX} ${DOOR_APEX_Y} L ${CX + DOOR_HALF} ${BASE_Y} L ${CX - DOOR_HALF} ${BASE_Y} Z`;
const POLE_PATH =
    `M ${CX - POLE_SPREAD} ${POLE_TOP_Y} L ${CX + 1.4} ${POLE_BOTTOM_Y} ` +
    `M ${CX + POLE_SPREAD} ${POLE_TOP_Y} L ${CX - 1.4} ${POLE_BOTTOM_Y}`;

// A square canvas holding the mark, centred, scaled to `markFrac` of the width.
// `bg` may be null for a transparent canvas (Android adaptive foreground).
function iconSvg(size, bg, fill, markFrac) {
    const markW = size * markFrac;
    const markH = markW * (H / W);
    const x = (size - markW) / 2;
    const y = (size - markH) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
        + (bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : '')
        + `<svg x="${x}" y="${y}" width="${markW}" height="${markH}" viewBox="0 0 ${W} ${H}">`
        + `<path d="${BODY_PATH}" fill="${fill}" fill-rule="evenodd"/>`
        + `<path d="${POLE_PATH}" stroke="${fill}" stroke-width="${POLE_W}" stroke-linecap="round" fill="none"/>`
        + `</svg></svg>`;
}

// Splash: same mark on the app's splash background, sized off the SHORT edge so
// it stays the same visual size in portrait and landscape.
function splashSvg(w, h, bg, fill) {
    const markW = Math.min(w, h) * 0.30;
    const markH = markW * (H / W);
    const x = (w - markW) / 2, y = (h - markH) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
        + `<rect width="${w}" height="${h}" fill="${bg}"/>`
        + `<svg x="${x}" y="${y}" width="${markW}" height="${markH}" viewBox="0 0 ${W} ${H}">`
        + `<path d="${BODY_PATH}" fill="${fill}" fill-rule="evenodd"/>`
        + `<path d="${POLE_PATH}" stroke="${fill}" stroke-width="${POLE_W}" stroke-linecap="round" fill="none"/>`
        + `</svg></svg>`;
}

const APPS = {
    lite: { brand: '#EE6A53', splashBg: '#F7F2EF' },
    link: { brand: '#166534', splashBg: '#FDFCFB' }
};

// `opaque` strips the alpha channel. App Store Connect REJECTS an app icon that
// carries one, even when every pixel is fully opaque — so the iOS icon and the
// 1024 master used for store listings must be flattened, while Android's
// adaptive foreground genuinely needs its transparency.
async function png(svg, file, opaque) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let img = sharp(Buffer.from(svg));
    if (opaque) img = img.flatten({ background: '#FFFFFF' }).removeAlpha();
    await img.png().toFile(file);
}

async function build(app) {
    const { brand, splashBg } = APPS[app];
    const root = path.join(__dirname, `campistry-${app}`);
    const res = path.join(root, 'android/app/src/main/res');
    let count = 0;

    // ── Master art, for regenerating later or handing to a store listing ──
    await png(iconSvg(1024, brand, '#FFFFFF', 0.52), path.join(root, 'resources/icon.png'), true);
    await png(splashSvg(2732, 2732, splashBg, brand), path.join(root, 'resources/splash.png'));
    count += 2;

    // ── iOS: a single 1024 icon (what modern Xcode asks for) ──
    await png(iconSvg(1024, brand, '#FFFFFF', 0.52),
        path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), true);
    for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
        await png(splashSvg(2732, 2732, splashBg, brand),
            path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset', f));
        count++;
    }
    count++;

    // ── Android launcher icons ──
    // Legacy square/round icons are full-bleed. The adaptive FOREGROUND has to
    // keep the mark inside the middle ~66% — Android crops the rest to whatever
    // mask the launcher uses (circle, squircle, rounded square).
    const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
    for (const [dpi, size] of Object.entries(LEGACY)) {
        await png(iconSvg(size, brand, '#FFFFFF', 0.52), path.join(res, `mipmap-${dpi}/ic_launcher.png`));
        await png(iconSvg(size, brand, '#FFFFFF', 0.52), path.join(res, `mipmap-${dpi}/ic_launcher_round.png`));
        count += 2;
    }
    for (const [dpi, size] of Object.entries(ADAPTIVE)) {
        await png(iconSvg(size, null, '#FFFFFF', 0.36), path.join(res, `mipmap-${dpi}/ic_launcher_foreground.png`));
        count++;
    }

    // The adaptive icon's background layer is a flat colour resource.
    fs.writeFileSync(path.join(res, 'values/ic_launcher_background.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${brand}</color>\n</resources>\n`);
    count++;

    // ── Android splash screens ──
    const SPLASH = {
        'drawable': [480, 320],
        'drawable-port-mdpi': [320, 480], 'drawable-land-mdpi': [480, 320],
        'drawable-port-hdpi': [480, 800], 'drawable-land-hdpi': [800, 480],
        'drawable-port-xhdpi': [720, 1280], 'drawable-land-xhdpi': [1280, 720],
        'drawable-port-xxhdpi': [960, 1600], 'drawable-land-xxhdpi': [1600, 960],
        'drawable-port-xxxhdpi': [1280, 1920], 'drawable-land-xxxhdpi': [1920, 1280]
    };
    for (const [dir, [w, h]] of Object.entries(SPLASH)) {
        await png(splashSvg(w, h, splashBg, brand), path.join(res, dir, 'splash.png'));
        count++;
    }

    console.log(`[icons] ${app}: ${count} images written (brand ${brand})`);
}

(async () => {
    for (const app of Object.keys(APPS)) await build(app);
    console.log('[icons] done');
})().catch(e => { console.error(e); process.exit(1); });
