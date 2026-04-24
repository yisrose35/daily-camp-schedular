// =============================================================================
// view_historical_routes.js
// =============================================================================
// Paste this entire file into the browser console while CampistryGo is loaded.
// It opens a popup window showing last year's actual routes plotted on a map,
// using camper coordinates from your currently-loaded routes.
//
// Make sure you've generated routes at least once so coords are available.
// =============================================================================

(async function viewHistoricalRoutes() {
    const COLORS = {
        BEIGE: '#d2b48c', BLACK: '#1a1a1a', BLUE: '#2563eb', BROWN: '#8b4513',
        CORAL: '#ff7f50', GOLD: '#ffd700', GRAY: '#808080', GREEN: '#16a34a',
        MAROON: '#800000', ORANGE: '#f97316', PEACH: '#ffcba4', PINK: '#ec4899',
        PURPLE: '#9333ea', RED: '#dc2626', SILVER: '#c0c0c0', TEAL: '#14b8a6',
        WHITE: '#f5f5f5', YELLOW: '#facc15'
    };

    let routes;
    try {
        const resp = await fetch('historical_routes.json');
        routes = await resp.json();
    } catch (e) {
        alert('Could not load historical_routes.json. Make sure it exists in the same folder as the app.');
        return;
    }

    // Build name → {lat, lng} map from currently saved routes
    const coords = {};
    const saved = window.CampistryGo?._getSavedRoutes?.();
    if (!saved) {
        alert('No saved routes found. Generate routes first so I have camper coordinates.');
        return;
    }

    function normalize(name) {
        return name.toLowerCase().replace(/[^a-z]/g, '');
    }

    // Iterate all stops in all shifts/buses
    function walkRoutes(node) {
        if (Array.isArray(node)) { node.forEach(walkRoutes); return; }
        if (!node || typeof node !== 'object') return;
        if (node.lat && node.lng && node.members && Array.isArray(node.members)) {
            node.members.forEach(m => {
                const nm = m.name || m.camperName || m;
                if (typeof nm === 'string') coords[normalize(nm)] = { lat: node.lat, lng: node.lng, displayName: nm };
            });
        } else if (node.lat && node.lng && (node.name || node.camperName)) {
            const nm = node.name || node.camperName;
            coords[normalize(nm)] = { lat: node.lat, lng: node.lng, displayName: nm };
        }
        Object.values(node).forEach(walkRoutes);
    }
    walkRoutes(saved);

    // Match historical names to coords. Try "Last, First" → "first last"
    const matched = {};
    let totalMatched = 0, totalMissing = 0;
    const missingNames = {};
    for (const [color, names] of Object.entries(routes)) {
        matched[color] = [];
        missingNames[color] = [];
        for (const lf of names) {
            const parts = lf.split(',').map(s => s.trim());
            const first = parts[1] || '';
            const last = parts[0] || '';
            const try1 = normalize(first + last);
            const try2 = normalize(last + first);
            const c = coords[try1] || coords[try2];
            if (c) { matched[color].push({ name: lf, lat: c.lat, lng: c.lng }); totalMatched++; }
            else { missingNames[color].push(lf); totalMissing++; }
        }
    }

    console.log('[Historical] Matched ' + totalMatched + ' / ' + (totalMatched + totalMissing));
    if (totalMissing > 0) {
        console.log('[Historical] Missing names by route:', missingNames);
    }

    // Open popup with Leaflet map
    const w = window.open('', 'historical', 'width=1200,height=800');
    if (!w) { alert('Popup blocked. Allow popups for this page and try again.'); return; }

    const html = `<!DOCTYPE html><html><head><title>Last Year's Routes — Dismissal</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
body{margin:0;font-family:system-ui,sans-serif}
#map{position:absolute;top:0;left:280px;right:0;bottom:0}
#side{position:absolute;top:0;left:0;width:280px;bottom:0;background:#f9fafb;border-right:1px solid #e5e7eb;overflow-y:auto;padding:12px;box-sizing:border-box}
h2{margin:0 0 8px 0;font-size:16px}
.route{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:4px;margin-bottom:2px;font-size:13px}
.route:hover{background:#e5e7eb}
.route.off{opacity:.3}
.dot{width:14px;height:14px;border-radius:50%;border:1px solid #555;flex-shrink:0}
.count{margin-left:auto;color:#666;font-size:12px}
button{margin:8px 4px 4px 0;padding:4px 10px;font-size:12px;cursor:pointer}
</style></head>
<body>
<div id="side">
<h2>Last Year's Routes</h2>
<div><button onclick="toggleAll(true)">All</button><button onclick="toggleAll(false)">None</button></div>
<div id="list"></div>
<div style="margin-top:12px;font-size:11px;color:#666">Click a route to toggle. Markers show actual camper homes.</div>
</div>
<div id="map"></div>
<script>
const COLORS = ${JSON.stringify(COLORS)};
const ROUTES = ${JSON.stringify(matched)};
const map = L.map('map').setView([40.08, -74.22], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OSM' }).addTo(map);
const layers = {};
const visible = {};
const allBounds = [];
for (const [color, campers] of Object.entries(ROUTES)) {
    const lg = L.layerGroup();
    campers.forEach(c => {
        const m = L.circleMarker([c.lat, c.lng], { radius: 5, color: '#222', weight: 1, fillColor: COLORS[color], fillOpacity: 0.85 });
        m.bindPopup('<b>' + color + '</b><br>' + c.name);
        m.addTo(lg);
        allBounds.push([c.lat, c.lng]);
    });
    layers[color] = lg;
    visible[color] = true;
    lg.addTo(map);
}
if (allBounds.length) map.fitBounds(allBounds, { padding: [20, 20] });

const list = document.getElementById('list');
for (const color of Object.keys(ROUTES)) {
    const div = document.createElement('div');
    div.className = 'route';
    div.innerHTML = '<span class="dot" style="background:' + COLORS[color] + '"></span><span>' + color + '</span><span class="count">' + ROUTES[color].length + '</span>';
    div.onclick = () => toggle(color, div);
    list.appendChild(div);
}
function toggle(color, div) {
    visible[color] = !visible[color];
    if (visible[color]) { layers[color].addTo(map); div.classList.remove('off'); }
    else { map.removeLayer(layers[color]); div.classList.add('off'); }
}
function toggleAll(on) {
    document.querySelectorAll('.route').forEach((div, i) => {
        const color = Object.keys(ROUTES)[i];
        if (visible[color] !== on) toggle(color, div);
    });
}
</script></body></html>`;

    w.document.write(html);
    w.document.close();
    console.log('[Historical] Popup opened. ' + Object.keys(matched).length + ' routes plotted.');
})();
