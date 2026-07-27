// =============================================================================
// campistry_go_luggage.js — Luggage, inside Campistry Go
//
// Bags to camp and home. This lives in Go rather than as its own app because
// Go IS the camp's transport system: it already models neighbourhoods, stops,
// addresses, vehicles and routes. Luggage drop-off points are stops in
// neighbourhoods, trucks are vehicles, and a manifest is a route sheet — the
// same problem shape, and the same camper addresses.
//
// Tag codes, pricing, the status machine and the manifests are in
// campistry_luggage_core.js (pure + unit tested). This file is storage and
// rendering only.
//
// DATA — campGlobalSettings_v1 -> campistryLuggage
//   settings:  { campPrefix, campName, pricing{...} }
//   locations: [ { id, name, address, date, windowStart, windowEnd, capacityBags } ]
//   bookings:  [ { id, ref, camperName, bunk, division, serviceType, pickupMode,
//                  locationId, address, counts{type:qty}, bags[], quotedTotal,
//                  paid, notes, status } ]
//
// Campers come from app1.camperRoster (Campistry Me) — picking one fills in
// bunk and division, which is what the bunk delivery sheet groups by.
//
// Mounts itself into #tab-luggage when Go shows that tab.
// =============================================================================
(function () {
'use strict';

var STORE_KEY = 'campGlobalSettings_v1';
var LC = null;
var lug = { settings: {}, locations: [], bookings: [] };
var tab = 'overview';
var editingBooking = null;
var editingLocation = null;
var tagFilter = 'all';       // which status the Tags tab prints

// ── storage ─────────────────────────────────────────────────────────────────
function readGlobal() {
    var keys = [STORE_KEY, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
    for (var i = 0; i < keys.length; i++) {
        try { var raw = localStorage.getItem(keys[i]); if (raw) return JSON.parse(raw) || {}; } catch (e) {}
    }
    return {};
}
function load() {
    var g = readGlobal();
    var s = g.campistryLuggage || {};
    lug = {
        settings: Object.assign({ campPrefix: '', campName: g.camp_name || g.campName || '', pricing: {} }, s.settings || {}),
        locations: Array.isArray(s.locations) ? s.locations : [],
        bookings: Array.isArray(s.bookings) ? s.bookings : []
    };
}
function save() {
    try {
        var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistryLuggage = lug;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) { console.warn('[Luggage] Local save failed:', e); }
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistryLuggage', lug);
        return;
    }
    try {
        var db = window.CampistryDB;
        var campId = db && db.getCampId && db.getCampId();
        if (!db || !db.client || !campId) return;
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistryLuggage', value: lug, updated_at: new Date().toISOString() },
                    { onConflict: 'camp_id,key' })
            .then(function (r) { if (r.error) console.warn('[Luggage] Cloud save failed:', r.error.message); });
    } catch (e) { console.warn('[Luggage] Cloud save error:', e); }
}

function camperList() {
    var g = readGlobal();
    var r = (g.app1 && g.app1.camperRoster) || {};
    return Object.keys(r).map(function (name) {
        var c = r[name] || {};
        return {
            name: name, bunk: c.bunk || '', division: c.division || '',
            // Bags follow the family home in the off-season and the summer
            // address during it, so both are worth having to hand.
            street: c.street || '', city: c.city || '', state: c.state || '', zip: c.zip || ''
        };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ── helpers ─────────────────────────────────────────────────────────────────
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML.replace(/"/g, '&quot;'); }
function money(n) { return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2); }
function el(id) { return document.getElementById(id); }
function val(id) { var e = el(id); return e ? String(e.value || '').trim() : ''; }
function num(id) { var v = parseFloat(val(id)); return isFinite(v) ? v : 0; }
function checked(id) { var e = el(id); return !!(e && e.checked); }
function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// Go already has a toast; use it rather than stacking a second one.
window.lugToast = function (msg, isErr) {
    var fn = window.toast || (window.CampistryGo && window.CampistryGo.toast);
    if (typeof fn === 'function') { try { fn(msg, isErr ? 'error' : ''); return; } catch (e) {} }
    console.log('[Luggage]', msg);
};
// Modals are built on demand and removed on close, so Go's page doesn't have
// to carry four hidden overlays it never uses.
function modal(id, title, bodyHtml, saveLabel, onSave, wide) {
    lugClose(id);
    var ov = document.createElement('div');
    ov.className = 'ops-overlay open';
    ov.id = 'm-' + id;
    ov.setAttribute('data-ops', 'luggage');
    ov.innerHTML =
        '<div class="ops-modal' + (wide ? ' ops-modal--lg' : '') + '">' +
            '<div class="ops-modal-head"><h2>' + esc(title) + '</h2>' +
                '<button class="ops-x" data-close="1">&times;</button></div>' +
            '<div class="ops-modal-body" id="' + id + 'Body"></div>' +
            '<div class="ops-modal-foot">' +
                '<button class="ops-btn" data-close="1">' + (onSave ? 'Cancel' : 'Close') + '</button>' +
                (onSave ? '<button class="ops-btn ops-btn--pri" id="' + id + 'Save">' + esc(saveLabel) + '</button>' : '') +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);
    el(id + 'Body').innerHTML = bodyHtml;
    ov.querySelectorAll('[data-close]').forEach(function (b) {
        b.addEventListener('click', function () { lugClose(id); });
    });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) lugClose(id); });
    if (onSave) el(id + 'Save').addEventListener('click', onSave);
    return ov;
}
window.lugClose = function (n) { var e = el('m-' + n); if (e) e.remove(); };

function stat(label, value, sub) {
    return '<div class="ops-stat"><div class="ops-stat-label">' + esc(label) + '</div>' +
        '<div class="ops-stat-value">' + value + '</div>' +
        (sub ? '<div class="ops-stat-sub">' + esc(sub) + '</div>' : '') + '</div>';
}
function empty(msg, cta) { return '<div class="ops-empty"><p>' + esc(msg) + '</p>' + (cta || '') + '</div>'; }
function bookingById(id) { return lug.bookings.filter(function (b) { return String(b.id) === String(id); })[0] || null; }
function locationById(id) { return lug.locations.filter(function (l) { return String(l.id) === String(id); })[0] || null; }
function locationName(id) { var l = locationById(id); return l ? l.name : ''; }
function campPrefixOpts() { return { campPrefix: lug.settings.campPrefix, campName: lug.settings.campName }; }

// ── render ──────────────────────────────────────────────────────────────────
var TABS = [
    { k: 'overview', l: 'Overview' },
    { k: 'bookings', l: 'Bookings' },
    { k: 'locations', l: 'Drop-offs' },
    { k: 'tags', l: 'Tags' },
    { k: 'manifest', l: 'Manifest' },
    { k: 'delivery', l: 'Bunk Delivery' }
];
window.lugTab = function (t) { tab = t; render(); };

/** Build the section shell inside Go's #tab-luggage, once. */
function mount() {
    var host = el('tab-luggage');
    if (!host) return false;
    if (!el('lugBody')) {
        host.innerHTML =
            '<div data-ops="luggage">' +
                '<div class="ops-hero">' +
                    '<div class="ops-hero-icon">' +
                        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/></svg>' +
                    '</div>' +
                    '<div><h1>Luggage</h1><p>Bags to camp and home — bookings, tags, trucks and bunk delivery</p></div>' +
                    '<div class="ops-hero-actions">' +
                        '<button class="ops-btn" onclick="lugExportCSV()">&darr; Export</button>' +
                        '<button class="ops-btn ops-btn--pri" onclick="lugNewBooking()">+ New Booking</button>' +
                    '</div>' +
                '</div>' +
                '<div class="ops-tabs" id="lugTabs"></div>' +
                '<div id="lugBody"></div>' +
            '</div>';
    }
    return true;
}

function render() {
    if (!mount()) return;
    var tabsEl = el('lugTabs');
    if (tabsEl) {
        tabsEl.innerHTML = TABS.map(function (t) {
            return '<button class="ops-tab' + (tab === t.k ? ' active' : '') + '" onclick="lugTab(\'' + t.k + '\')">' + t.l + '</button>';
        }).join('');
    }
    var body = el('lugBody'); if (!body) return;
    if (!LC) { body.innerHTML = '<div class="ops-empty"><p>Luggage engine didn\'t load — reload the page.</p></div>'; return; }
    body.innerHTML =
        tab === 'overview' ? renderOverview()
      : tab === 'bookings' ? renderBookings()
      : tab === 'locations' ? renderLocations()
      : tab === 'tags' ? renderTags()
      : tab === 'manifest' ? renderManifest()
      : renderDelivery();
}

function renderOverview() {
    var s = LC.summary(lug.bookings);
    var revenue = lug.bookings.reduce(function (sum, b) {
        return b.status === 'cancelled' ? sum : sum + (parseFloat(b.quotedTotal) || 0);
    }, 0);
    var collected = lug.bookings.reduce(function (sum, b) {
        return (b.paid && b.status !== 'cancelled') ? sum + (parseFloat(b.quotedTotal) || 0) : sum;
    }, 0);

    var h = '<div class="ops-stats">' +
        stat('Bookings', s.bookings, '') +
        stat('Bags', s.bags, s.bags ? s.percentComplete + '% delivered' : '') +
        stat('Exceptions', s.exceptions, s.exceptions ? 'Missing or damaged' : 'None') +
        stat('Billed', money(revenue), money(collected) + ' collected') +
        '</div>';

    // What Luggage is for, once, so an office opening it cold knows the shape.
    h += '<div class="ops-card"><div class="ops-card-body">' +
        '<h3 style="margin:0 0 6px;font-size:.92rem;color:var(--ops-ink)">How this works</h3>' +
        '<p class="ops-note" style="margin:0">Bags travel separately from campers — they leave a day early so they\'re on the bed when the bus arrives. ' +
        'Families either bring bags to a communal drop-off in their neighbourhood on a set date and time window, or pay more for a private pick-up at the house. ' +
        'Every bag gets a tag before it moves, and each scan pushes it one step along: tagged → received → loaded → in transit → at camp → delivered to bunk. ' +
        'The manifest shows what should be on a truck; the bunk delivery sheet is what the crew carries.</p></div></div>';

    if (!lug.bookings.length) {
        return h + empty('No bookings yet. Set up your drop-off locations first, then take bookings.',
            '<button class="ops-btn ops-btn--pri" onclick="lugNewBooking()">+ New Booking</button>');
    }

    // Where every bag currently is.
    h += '<div class="ops-card"><div class="ops-card-head"><h2>Where the bags are</h2></div><div class="ops-card-body">';
    var max = Math.max.apply(null, LC.STATUS_IDS.map(function (id) { return s.byStatus[id] || 0; }).concat([1]));
    LC.STATUSES.forEach(function (st) {
        var n = s.byStatus[st.id] || 0;
        if (!n && st.id === 'exception') return;
        h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">' +
            '<div style="width:130px;font-size:.78rem;font-weight:600;color:var(--ops-muted);text-align:right">' + esc(st.label) + '</div>' +
            '<div style="flex:1;height:20px;background:var(--ops-line-soft);border-radius:4px;overflow:hidden">' +
                '<div style="width:' + Math.round(n / max * 100) + '%;height:100%;background:' + (st.problem ? 'var(--ops-err)' : 'var(--ops-accent)') + ';border-radius:4px"></div></div>' +
            '<div style="width:40px;font-size:.8rem;font-weight:700;text-align:right">' + n + '</div></div>';
    });
    h += '</div></div>';

    // Per-location load, with the over-capacity ones called out.
    if (lug.locations.length) {
        h += '<div class="ops-card"><div class="ops-card-head"><h2>Drop-off Load</h2></div>' +
            '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Location</th><th>Date</th><th>Window</th><th class="num">Bookings</th><th class="num">Bags</th><th>Capacity</th></tr></thead><tbody>';
        lug.locations.forEach(function (loc) {
            var load = LC.locationLoad(loc, lug.bookings);
            h += '<tr><td class="bold">' + esc(loc.name) + '</td><td>' + esc(loc.date || '—') + '</td>' +
                '<td>' + esc([loc.windowStart, loc.windowEnd].filter(Boolean).join('–') || '—') + '</td>' +
                '<td class="num">' + load.bookings + '</td><td class="num">' + load.bags + '</td>' +
                '<td>' + (load.capacityBags
                    ? (load.over ? '<span class="ops-badge ops-badge--err">Over by ' + (load.bags - load.capacityBags) + '</span>'
                                 : '<span class="ops-badge ops-badge--ok">' + load.remaining + ' left</span>')
                    : '<span class="ops-badge">No cap</span>') + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
    }
    return h;
}

function renderBookings() {
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Bookings</h2>' +
        '<div style="display:flex;gap:8px"><button class="ops-btn ops-btn--sm" onclick="lugEditPricing()">Pricing</button>' +
        '<button class="ops-btn ops-btn--pri ops-btn--sm" onclick="lugNewBooking()">+ New Booking</button></div></div>';
    if (!lug.bookings.length) return h + empty('No bookings yet.');

    h += '<div class="ops-card"><div class="ops-tw"><table class="ops-t"><thead><tr>' +
        '<th>Ref</th><th>Camper</th><th>Bunk</th><th>Service</th><th>Drop-off</th><th class="num">Bags</th><th class="num">Price</th><th>Paid</th><th></th></tr></thead><tbody>';
    lug.bookings.slice().sort(function (a, b) { return String(a.camperName).localeCompare(String(b.camperName)); })
        .forEach(function (b) {
            var svc = LC.SERVICE_TYPES.filter(function (s) { return s.id === b.serviceType; })[0];
            h += '<tr class="click' + (b.status === 'cancelled' ? '" style="opacity:.5' : '') + '" onclick="lugEditBooking(\'' + esc(b.id) + '\')">' +
                '<td style="font-family:ui-monospace,monospace;font-size:.78rem">' + esc(b.ref || '—') + '</td>' +
                '<td class="bold">' + esc(b.camperName || '—') + '</td>' +
                '<td>' + esc(b.bunk || '—') + '</td>' +
                '<td style="font-size:.8rem">' + esc(svc ? svc.label : b.serviceType || '—') +
                    (b.pickupMode === 'private' ? ' <span class="ops-badge ops-badge--info">Home</span>' : '') + '</td>' +
                '<td style="font-size:.8rem">' + esc(b.pickupMode === 'private' ? 'Private pick-up' : (locationName(b.locationId) || '—')) + '</td>' +
                '<td class="num">' + LC.bagCount(b) + '</td>' +
                '<td class="num">' + money(b.quotedTotal) + '</td>' +
                '<td>' + (b.paid ? '<span class="ops-badge ops-badge--ok">Paid</span>' : '<span class="ops-badge ops-badge--warn">Unpaid</span>') + '</td>' +
                '<td style="text-align:right" onclick="event.stopPropagation()">' +
                    '<button class="ops-btn ops-btn--sm ops-btn--danger" onclick="lugDeleteBooking(\'' + esc(b.id) + '\')">✕</button></td></tr>';
        });
    h += '</tbody></table></div></div>';
    return h;
}

function renderLocations() {
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Drop-off Locations</h2>' +
        '<button class="ops-btn ops-btn--pri ops-btn--sm" onclick="lugEditLocation()">+ Add Location</button></div>';
    h += '<p class="ops-note" style="margin:0 0 14px">A neighbourhood drop-off point with a date and a time window — Brooklyn, Monsey, Five Towns, wherever your families are. ' +
        'Capacity is measured in <strong>bags</strong>, not bookings, because that\'s what fills a truck.</p>';
    if (!lug.locations.length) {
        return h + empty('No drop-off locations yet.',
            '<button class="ops-btn ops-btn--pri" onclick="lugEditLocation()">+ Add Location</button>');
    }
    h += '<div class="ops-card"><div class="ops-tw"><table class="ops-t"><thead><tr>' +
        '<th>Name</th><th>Address</th><th>Date</th><th>Window</th><th class="num">Bags</th><th>Capacity</th><th></th></tr></thead><tbody>';
    lug.locations.forEach(function (loc) {
        var load = LC.locationLoad(loc, lug.bookings);
        h += '<tr class="click" onclick="lugEditLocation(\'' + esc(loc.id) + '\')">' +
            '<td class="bold">' + esc(loc.name) + '</td>' +
            '<td style="font-size:.8rem">' + esc(loc.address || '—') + '</td>' +
            '<td>' + esc(loc.date || '—') + '</td>' +
            '<td>' + esc([loc.windowStart, loc.windowEnd].filter(Boolean).join('–') || '—') + '</td>' +
            '<td class="num">' + load.bags + '</td>' +
            '<td>' + (load.capacityBags ? (load.over ? '<span class="ops-badge ops-badge--err">Over</span>' : load.capacityBags) : '—') + '</td>' +
            '<td style="text-align:right" onclick="event.stopPropagation()">' +
                '<button class="ops-btn ops-btn--sm ops-btn--danger" onclick="lugDeleteLocation(\'' + esc(loc.id) + '\')">✕</button></td></tr>';
    });
    h += '</tbody></table></div></div>';
    return h;
}

// ── tags ────────────────────────────────────────────────────────────────────
function renderTags() {
    var bags = LC.allBags(lug.bookings);
    if (tagFilter !== 'all') bags = bags.filter(function (b) { return b.status === tagFilter; });
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Bag Tags</h2>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<select class="ops-select" style="width:auto" onchange="lugTagFilter(this.value)">' +
        '<option value="all">All bags</option>' +
        LC.STATUSES.map(function (s) { return '<option value="' + s.id + '"' + (tagFilter === s.id ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') +
        '</select>' +
        '<button class="ops-btn ops-btn--sm" onclick="lugMarkAllTagged()">Mark all tagged</button>' +
        '<button class="ops-btn ops-btn--pri ops-btn--sm" onclick="window.print()">Print tags</button></div></div>';
    h += '<p class="ops-note" style="margin:0 0 14px">Tag codes are derived from the booking, so reprinting a lost tag gives the <strong>same</strong> code — a bag never ends up with two identities.</p>';
    if (!bags.length) return h + empty('No bags to tag.');

    h += '<div class="ops-tags">';
    bags.forEach(function (b) {
        var type = LC.BAG_TYPES.filter(function (t) { return t.id === b.type; })[0];
        h += '<div class="ops-tag">' +
            '<div class="ops-tag-camp">' + esc(lug.settings.campName || 'Camp') +
                '<span class="ops-tag-of">' + esc(type ? type.label : b.type) + '</span></div>' +
            '<div class="ops-tag-name">' + esc(b.camperName || '—') + '</div>' +
            '<div class="ops-tag-bunk">' + esc([b.division, b.bunk].filter(Boolean).join(' · ') || 'Bunk TBD') + '</div>' +
            '<div class="ops-tag-code">' + esc(b.tag) + '</div>' +
            '</div>';
    });
    h += '</div>';
    return h;
}
window.lugTagFilter = function (v) { tagFilter = v; render(); };

window.lugMarkAllTagged = function () {
    var moved = 0;
    lug.bookings.forEach(function (bk) {
        (bk.bags || []).forEach(function (bag, i) {
            if (bag.status !== 'registered') return;
            var res = LC.setStatus(bag, 'tagged', { at: today(), by: 'Office' });
            if (res.ok) { bk.bags[i] = res.bag; moved++; }
        });
    });
    if (!moved) { lugToast('Nothing left to tag'); return; }
    save(); render();
    lugToast(moved + ' bag' + (moved === 1 ? '' : 's') + ' marked tagged');
};

// ── manifest ────────────────────────────────────────────────────────────────
function renderManifest() {
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Truck Manifest</h2>' +
        '<div style="display:flex;gap:8px"><button class="ops-btn ops-btn--sm" onclick="lugOpenScan()">Scan bags</button>' +
        '<button class="ops-btn ops-btn--sm" onclick="window.print()">Print</button></div></div>';

    var locs = lug.locations.slice();
    // Bookings whose location was deleted (or that are private pick-ups) still
    // have bags on a truck — give them their own group rather than losing them.
    locs.push({ id: '', name: 'Private pick-ups / unassigned' });

    var any = false;
    locs.forEach(function (loc) {
        var m = LC.manifest(lug.bookings, { locationId: loc.id });
        if (!m.total) return;
        any = true;
        h += '<div class="ops-card"><div class="ops-card-head"><h3>' + esc(loc.name) + '</h3>' +
            '<div style="display:flex;gap:6px;align-items:center">' +
            '<span class="ops-badge">' + m.total + ' bag' + (m.total === 1 ? '' : 's') + '</span>' +
            '<span class="ops-badge ops-badge--info">' + m.onBoard + ' on board</span>' +
            (m.exceptions.length ? '<span class="ops-badge ops-badge--err">' + m.exceptions.length + ' exception</span>' : '') +
            '</div></div>' +
            '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Tag</th><th>Camper</th><th>Bunk</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>';
        m.bags.forEach(function (b) {
            var st = LC.statusMeta(b.status) || { label: b.status };
            var type = LC.BAG_TYPES.filter(function (t) { return t.id === b.type; })[0];
            h += '<tr><td style="font-family:ui-monospace,monospace;font-size:.78rem">' + esc(b.tag) + '</td>' +
                '<td class="bold">' + esc(b.camperName) + '</td>' +
                '<td>' + esc(b.bunk || '—') + '</td>' +
                '<td style="font-size:.8rem">' + esc(type ? type.label : b.type) + '</td>' +
                '<td><span class="ops-badge ' + (st.problem ? 'ops-badge--err' : st.terminal ? 'ops-badge--ok' : 'ops-badge--info') + '">' + esc(st.label) + '</span></td>' +
                '<td style="text-align:right">' + statusButtons(b) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
    });
    if (!any) h += empty('No bags booked yet.');
    return h;
}

/** Only the moves the status machine actually allows from here. */
function statusButtons(bag) {
    return LC.nextStatuses(bag.status).slice(0, 3).map(function (to) {
        var meta = LC.statusMeta(to) || { label: to };
        return '<button class="ops-btn ops-btn--sm' + (to === 'exception' ? ' ops-btn--danger' : '') + '" ' +
            'onclick="lugMove(\'' + esc(bag.bookingId) + '\',\'' + esc(bag.tag) + '\',\'' + to + '\')">' + esc(meta.label) + '</button>';
    }).join(' ');
}

window.lugMove = function (bookingId, tagCode, to) {
    var bk = bookingById(bookingId); if (!bk) return;
    var i = (bk.bags || []).findIndex(function (b) { return b.tag === tagCode; });
    if (i < 0) return;
    var res = LC.setStatus(bk.bags[i], to, { at: today(), by: 'Office' });
    if (!res.ok) { lugToast(res.error, 1); return; }
    bk.bags[i] = res.bag;
    save(); render();
    lugToast(tagCode + ' → ' + (LC.statusMeta(to) || {}).label);
};

window.lugOpenScan = function () {
    var h =
        '<div class="ops-field"><label>Move to</label><select class="ops-select" id="scanTo">' +
        LC.STATUS_IDS.map(function (id) {
            var m = LC.statusMeta(id);
            return '<option value="' + id + '"' + (id === 'loaded' ? ' selected' : '') + '>' + m.label + '</option>';
        }).join('') + '</select></div>' +
        '<div class="ops-field"><label>Tag codes</label>' +
        '<textarea class="ops-textarea" id="scanTags" style="min-height:150px;font-family:ui-monospace,monospace" placeholder="One per line, or scan straight into this box"></textarea>' +
        '<span class="ops-hint">Case doesn\'t matter. A bag that can\'t legally make this move is reported rather than forced — that\'s usually a missed scan earlier in the chain.</span></div>' +
        '<div id="scanResult"></div>';
    modal('scan', 'Scan Bags', h, 'Apply', lugRunScan);
};

window.lugRunScan = function () {
    var to = val('scanTo');
    var tags = val('scanTags').split(/[\s,]+/).filter(Boolean);
    if (!tags.length) { lugToast('Paste or scan some tag codes', 1); return; }
    var res = LC.scanBatch(lug.bookings, tags, to, { at: today(), by: 'Scan' });
    // scanBatch is pure — write the moved bags back.
    res.moved.forEach(function (m) {
        var bk = bookingById(m.bookingId); if (!bk) return;
        var i = bk.bags.findIndex(function (b) { return b.tag === m.tag; });
        if (i >= 0) bk.bags[i] = m.bag;
    });
    save();
    var out = el('scanResult');
    if (out) {
        out.innerHTML = '<div style="margin-top:12px;padding:11px 13px;border-radius:var(--ops-r-sm);background:var(--ops-line-soft);font-size:.82rem">' +
            '<div><strong>' + res.moved.length + '</strong> moved</div>' +
            (res.failed.length ? '<div style="color:var(--ops-warn);margin-top:5px"><strong>' + res.failed.length + '</strong> couldn\'t move:<br>' +
                res.failed.map(function (f) { return esc(f.tag) + ' — ' + esc(f.error); }).join('<br>') + '</div>' : '') +
            (res.unknown.length ? '<div style="color:var(--ops-err);margin-top:5px"><strong>' + res.unknown.length + '</strong> unknown tag' +
                (res.unknown.length === 1 ? '' : 's') + ': ' + esc(res.unknown.join(', ')) + '</div>' : '') +
            '</div>';
    }
    render();
    lugToast(res.moved.length + ' bag' + (res.moved.length === 1 ? '' : 's') + ' updated');
};

// ── bunk delivery ───────────────────────────────────────────────────────────
function renderDelivery() {
    var groups = LC.deliveryByBunk(lug.bookings);
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Bunk Delivery Sheet</h2>' +
        '<button class="ops-btn ops-btn--sm" onclick="window.print()">Print</button></div>';
    h += '<p class="ops-note" style="margin:0 0 14px">What the crew carries when bags go on beds. A bag with no bunk yet is grouped at the bottom rather than left off — that\'s exactly the one that goes missing.</p>';
    if (!groups.length) return h + empty('No bags booked yet.');

    groups.forEach(function (g) {
        var delivered = g.bags.filter(function (b) { return b.status === 'delivered'; }).length;
        h += '<div class="ops-card"><div class="ops-card-head"><h3>' + esc(g.bunk) + '</h3>' +
            '<div style="display:flex;gap:6px;align-items:center">' +
            '<span class="ops-badge">' + g.camperCount + ' camper' + (g.camperCount === 1 ? '' : 's') + '</span>' +
            '<span class="ops-badge ' + (delivered === g.bagCount ? 'ops-badge--ok' : 'ops-badge--warn') + '">' +
                delivered + ' / ' + g.bagCount + ' delivered</span></div></div>' +
            '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Camper</th><th>Tag</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>';
        g.bags.forEach(function (b) {
            var st = LC.statusMeta(b.status) || { label: b.status };
            var type = LC.BAG_TYPES.filter(function (t) { return t.id === b.type; })[0];
            h += '<tr><td class="bold">' + esc(b.camperName) + '</td>' +
                '<td style="font-family:ui-monospace,monospace;font-size:.78rem">' + esc(b.tag) + '</td>' +
                '<td style="font-size:.8rem">' + esc(type ? type.label : b.type) + '</td>' +
                '<td><span class="ops-badge ' + (st.problem ? 'ops-badge--err' : st.terminal ? 'ops-badge--ok' : '') + '">' + esc(st.label) + '</span></td>' +
                '<td style="text-align:right">' + statusButtons(b) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
    });
    return h;
}

// ── booking editor ──────────────────────────────────────────────────────────
window.lugNewBooking = function () { lugEditBooking(null); };

window.lugEditBooking = function (id) {
    editingBooking = id || null;
    var b = editingBooking ? (bookingById(editingBooking) || {}) : {};
    var counts = b.counts || {};

    var campers = camperList();
    var h = '<div class="ops-fsec">Camper</div>' +
        '<div class="ops-row"><div class="ops-field"><label>Camper</label>' +
        '<select class="ops-select" id="bkCamper" onchange="lugCamperPicked()"><option value="">— Select —</option>' +
        campers.map(function (c) {
            return '<option value="' + esc(c.name) + '"' + (b.camperName === c.name ? ' selected' : '') + '>' +
                esc(c.name) + (c.bunk ? ' (' + esc(c.bunk) + ')' : '') + '</option>';
        }).join('') + '</select></div>' +
        '<div class="ops-field"><label>Bunk</label><input class="ops-input" id="bkBunk" value="' + esc(b.bunk || '') + '"></div>' +
        '<div class="ops-field"><label>Division</label><input class="ops-input" id="bkDiv" value="' + esc(b.division || '') + '"></div></div>';

    h += '<div class="ops-fsec">Service</div>' +
        '<div class="ops-row"><div class="ops-field"><label>Direction</label>' +
        '<select class="ops-select" id="bkService" onchange="lugQuote()">' +
        LC.SERVICE_TYPES.map(function (s) { return '<option value="' + s.id + '"' + ((b.serviceType || 'round') === s.id ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="ops-field"><label>Collection</label>' +
        '<select class="ops-select" id="bkMode" onchange="lugModeChanged()">' +
        LC.PICKUP_MODES.map(function (m) { return '<option value="' + m.id + '"' + ((b.pickupMode || 'communal') === m.id ? ' selected' : '') + '>' + m.label + '</option>'; }).join('') +
        '</select></div></div>';

    h += '<div id="bkLocWrap" class="ops-field"><label>Drop-off location</label>' +
        '<select class="ops-select" id="bkLocation" onchange="lugQuote()"><option value="">— Select —</option>' +
        lug.locations.map(function (l) {
            return '<option value="' + esc(l.id) + '"' + (b.locationId === l.id ? ' selected' : '') + '>' +
                esc(l.name) + (l.date ? ' — ' + esc(l.date) : '') + '</option>';
        }).join('') + '</select>' +
        (lug.locations.length ? '' : '<span class="ops-hint">No locations set up yet — add one on the Drop-offs tab.</span>') + '</div>';

    h += '<div id="bkAddrWrap" class="ops-field" style="display:none"><label>Pick-up address</label>' +
        '<input class="ops-input" id="bkAddress" value="' + esc(b.address || '') + '" placeholder="Street, city, state, ZIP"></div>';

    h += '<div class="ops-fsec">Bags</div><div class="ops-row">' +
        LC.BAG_TYPES.map(function (t) {
            return '<div class="ops-field" style="min-width:110px"><label>' + esc(t.label) + '</label>' +
                '<input class="ops-input" type="number" min="0" id="bkCount_' + t.id + '" value="' + (counts[t.id] || '') + '" placeholder="0" oninput="lugQuote()"></div>';
        }).join('') + '</div>' +
        '<div class="ops-field"><label class="ops-check"><input type="checkbox" id="bkOversize"' + (b.oversize ? ' checked' : '') + ' onchange="lugQuote()"> Includes an oversize piece</label></div>';

    h += '<div class="ops-fsec">Billing</div>' +
        '<div id="bkQuote" style="padding:12px 14px;background:var(--ops-line-soft);border-radius:var(--ops-r-sm);margin-bottom:12px"></div>' +
        '<div class="ops-row">' +
        '<div class="ops-field"><label class="ops-check"><input type="checkbox" id="bkPaid"' + (b.paid ? ' checked' : '') + '> Paid</label></div>' +
        '<div class="ops-field"><label>Status</label><select class="ops-select" id="bkStatus">' +
            ['active', 'cancelled'].map(function (s) { return '<option value="' + s + '"' + ((b.status || 'active') === s ? ' selected' : '') + '>' + (s === 'active' ? 'Active' : 'Cancelled') + '</option>'; }).join('') +
        '</select></div></div>' +
        '<div class="ops-field"><label>Notes</label><textarea class="ops-textarea" id="bkNotes">' + esc(b.notes || '') + '</textarea></div>';

    modal('bk', editingBooking ? 'Edit Booking' : 'New Booking', h, 'Save Booking', lugSaveBooking, true);
    lugModeChanged();
};

window.lugCamperPicked = function () {
    var name = val('bkCamper');
    var c = camperList().filter(function (x) { return x.name === name; })[0];
    if (!c) return;
    // Bunk and division drive the delivery sheet, so fill them from the roster
    // rather than making the office retype them.
    var bunk = el('bkBunk'), div = el('bkDiv'), addr = el('bkAddress');
    if (bunk && !bunk.value) bunk.value = c.bunk || '';
    if (div && !div.value) div.value = c.division || '';
    if (addr && !addr.value) addr.value = [c.street, c.city, c.state, c.zip].filter(Boolean).join(', ');
};

window.lugModeChanged = function () {
    var priv = val('bkMode') === 'private';
    var locWrap = el('bkLocWrap'), addrWrap = el('bkAddrWrap');
    if (locWrap) locWrap.style.display = priv ? 'none' : '';
    if (addrWrap) addrWrap.style.display = priv ? '' : 'none';
    lugQuote();
};

function draftBooking() {
    var counts = {};
    LC.BAG_TYPES.forEach(function (t) {
        var n = parseInt(val('bkCount_' + t.id), 10);
        if (isFinite(n) && n > 0) counts[t.id] = n;
    });
    return {
        camperName: val('bkCamper'), bunk: val('bkBunk'), division: val('bkDiv'),
        serviceType: val('bkService') || 'round',
        pickupMode: val('bkMode') || 'communal',
        locationId: val('bkMode') === 'private' ? '' : val('bkLocation'),
        address: val('bkAddress'),
        counts: counts,
        oversize: checked('bkOversize'),
        paid: checked('bkPaid'),
        status: val('bkStatus') || 'active',
        notes: val('bkNotes')
    };
}

window.lugQuote = function () {
    var b = draftBooking();
    var q = LC.quote(b, lug.settings.pricing);
    var box = el('bkQuote');
    if (!box) return;
    box.innerHTML =
        '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>' + esc(q.serviceLabel) + ' · ' + q.bags + ' bag' + (q.bags === 1 ? '' : 's') + '</span><span></span></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>Base' + (b.pickupMode === 'private' ? ' (private pick-up)' : '') + '</span><strong>' + money(q.base) + '</strong></div>' +
        (q.extraBags ? '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>' + q.extraBags + ' extra bag' + (q.extraBags === 1 ? '' : 's') + '</span><strong>' + money(q.extraBagsFee) + '</strong></div>' : '') +
        (q.legs > 1 ? '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>Both directions</span><strong>×2 legs</strong></div>' : '') +
        '<div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;margin-top:6px;padding-top:6px;border-top:1px solid var(--ops-line)"><span>Total</span><span>' + money(q.total) + '</span></div>';
};

window.lugSaveBooking = function () {
    var d = draftBooking();
    if (!d.camperName) { lugToast('Pick a camper', 1); return; }
    if (!LC.bagCount(d)) { lugToast('Add at least one bag', 1); return; }
    if (d.pickupMode === 'communal' && !d.locationId) { lugToast('Pick a drop-off location', 1); return; }

    var existing = editingBooking ? bookingById(editingBooking) : null;
    var seq = existing ? (existing.seq || 1)
                       : (lug.bookings.reduce(function (m, b) { return Math.max(m, b.seq || 0); }, 0) + 1);
    var rec = Object.assign({}, existing || {}, d, {
        id: existing ? existing.id : ('lug_' + Date.now() + '_' + Math.floor(Math.random() * 1e4)),
        seq: seq,
        ref: existing ? existing.ref : LC.bookingRef(d.camperName, seq),
        quotedTotal: LC.quote(d, lug.settings.pricing).total,
        createdAt: (existing && existing.createdAt) || new Date().toISOString()
    });
    // buildBags keeps any bag already in transit at its current status and only
    // creates records for newly added pieces.
    rec.bags = LC.buildBags(Object.assign({}, rec, { bags: (existing && existing.bags) || [] }), campPrefixOpts());

    if (existing) {
        var i = lug.bookings.findIndex(function (x) { return x.id === existing.id; });
        lug.bookings[i] = rec;
    } else lug.bookings.push(rec);

    save(); lugClose('bk'); render();
    lugToast(existing ? 'Booking updated' : 'Booking created — ' + rec.ref);
};

window.lugDeleteBooking = function (id) {
    var b = bookingById(id); if (!b) return;
    if (!confirm('Delete the booking for ' + (b.camperName || 'this camper') + '? Its bags and their history go too.')) return;
    lug.bookings = lug.bookings.filter(function (x) { return x.id !== id; });
    save(); render();
    lugToast('Booking deleted');
};

// ── locations ───────────────────────────────────────────────────────────────
window.lugEditLocation = function (id) {
    editingLocation = id || null;
    var l = editingLocation ? (locationById(editingLocation) || {}) : {};
    var h =
        '<div class="ops-field"><label>Name</label><input class="ops-input" id="locName" value="' + esc(l.name || '') + '" placeholder="Brooklyn"></div>' +
        '<div class="ops-field"><label>Address</label><input class="ops-input" id="locAddress" value="' + esc(l.address || '') + '" placeholder="Corner of 13th Ave & 45th St"></div>' +
        '<div class="ops-row">' +
        '<div class="ops-field"><label>Date</label><input class="ops-input" id="locDate" type="date" value="' + esc(l.date || '') + '"></div>' +
        '<div class="ops-field"><label>From</label><input class="ops-input" id="locStart" type="time" value="' + esc(l.windowStart || '') + '"></div>' +
        '<div class="ops-field"><label>To</label><input class="ops-input" id="locEnd" type="time" value="' + esc(l.windowEnd || '') + '"></div></div>' +
        '<div class="ops-field"><label>Capacity (bags)</label><input class="ops-input" id="locCap" type="number" min="0" value="' + (l.capacityBags || '') + '" placeholder="Leave blank for no cap">' +
        '<span class="ops-hint">Bags, not bookings — one family can bring six.</span></div>';
    modal('loc', editingLocation ? 'Edit Location' : 'Add Drop-off Location', h, 'Save Location', lugSaveLocation);
};

window.lugSaveLocation = function () {
    var name = val('locName');
    if (!name) { lugToast('Name is required', 1); return; }
    var existing = editingLocation ? locationById(editingLocation) : null;
    var rec = {
        id: existing ? existing.id : ('loc_' + Date.now() + '_' + Math.floor(Math.random() * 1e4)),
        name: name, address: val('locAddress'), date: val('locDate'),
        windowStart: val('locStart'), windowEnd: val('locEnd'),
        capacityBags: Math.max(0, parseInt(val('locCap'), 10) || 0)
    };
    if (existing) {
        var i = lug.locations.findIndex(function (x) { return x.id === existing.id; });
        lug.locations[i] = rec;
    } else lug.locations.push(rec);
    save(); lugClose('loc'); render();
    lugToast(existing ? 'Location updated' : 'Location added');
};

window.lugDeleteLocation = function (id) {
    var load = LC.locationLoad({ id: id }, lug.bookings);
    if (load.bookings) {
        // Deleting out from under live bookings would strand their bags with a
        // location id that resolves to nothing.
        lugToast('Move its ' + load.bookings + ' booking' + (load.bookings === 1 ? '' : 's') + ' first', 1);
        return;
    }
    if (!confirm('Delete this drop-off location?')) return;
    lug.locations = lug.locations.filter(function (x) { return x.id !== id; });
    save(); render();
    lugToast('Location deleted');
};

// ── pricing ─────────────────────────────────────────────────────────────────
window.lugEditPricing = function () {
    var p = LC.pricing(lug.settings.pricing);
    var h =
        '<div class="ops-fsec">Camp</div>' +
        '<div class="ops-row">' +
        '<div class="ops-field"><label>Camp name</label><input class="ops-input" id="pcName" value="' + esc(lug.settings.campName || '') + '"></div>' +
        '<div class="ops-field"><label>Tag prefix</label><input class="ops-input" id="pcPrefix" maxlength="4" value="' + esc(lug.settings.campPrefix || '') + '" placeholder="CR">' +
        '<span class="ops-hint">Up to 4 letters, starts every tag code.</span></div></div>' +
        '<div class="ops-fsec">Pricing</div>' +
        '<div class="ops-row">' +
        '<div class="ops-field"><label>Communal drop-off ($)</label><input class="ops-input" id="pcBase" type="number" min="0" step="1" value="' + p.communalBase + '"></div>' +
        '<div class="ops-field"><label>Bags included</label><input class="ops-input" id="pcIncluded" type="number" min="0" value="' + p.includedBags + '"></div>' +
        '<div class="ops-field"><label>Each extra bag ($)</label><input class="ops-input" id="pcExtra" type="number" min="0" step="1" value="' + p.extraBagFee + '"></div></div>' +
        '<div class="ops-row">' +
        '<div class="ops-field"><label>Private home pick-up ($)</label><input class="ops-input" id="pcPrivate" type="number" min="0" step="1" value="' + p.privatePickupFee + '">' +
        '<span class="ops-hint">Replaces the communal base — it already covers collection.</span></div>' +
        '<div class="ops-field"><label>Return leg</label><input class="ops-input" id="pcReturn" type="number" min="0" step="0.1" value="' + p.returnLegMultiplier + '">' +
        '<span class="ops-hint">1 = same price both ways. 0.5 = half price home.</span></div>' +
        '<div class="ops-field"><label>Oversize fee ($)</label><input class="ops-input" id="pcOversize" type="number" min="0" step="1" value="' + p.oversizeFee + '"></div></div>';
    modal('pricing', 'Pricing & Camp Details', h, 'Save', lugSavePricing);
};

window.lugSavePricing = function () {
    lug.settings.campName = val('pcName');
    lug.settings.campPrefix = val('pcPrefix').toUpperCase();
    lug.settings.pricing = LC.pricing({
        communalBase: num('pcBase'), includedBags: num('pcIncluded'),
        extraBagFee: num('pcExtra'), privatePickupFee: num('pcPrivate'),
        returnLegMultiplier: num('pcReturn'), oversizeFee: num('pcOversize')
    });
    // Existing bookings keep the price they were quoted — re-pricing a booking
    // a family already paid would be wrong. New bookings pick up the change.
    save(); lugClose('pricing'); render();
    lugToast('Pricing saved — existing bookings keep their quoted price');
};

// ── export ──────────────────────────────────────────────────────────────────
window.lugExportCSV = function () {
    var rows = [['Ref', 'Camper', 'Bunk', 'Division', 'Service', 'Collection', 'Drop-off', 'Tag', 'Bag type', 'Status', 'Price', 'Paid']];
    lug.bookings.forEach(function (b) {
        var svc = LC.SERVICE_TYPES.filter(function (s) { return s.id === b.serviceType; })[0];
        (b.bags || []).forEach(function (bag) {
            var t = LC.BAG_TYPES.filter(function (x) { return x.id === bag.type; })[0];
            var st = LC.statusMeta(bag.status);
            rows.push([b.ref || '', b.camperName || '', b.bunk || '', b.division || '',
                       svc ? svc.label : b.serviceType, b.pickupMode === 'private' ? 'Private pick-up' : 'Communal',
                       locationName(b.locationId), bag.tag, t ? t.label : bag.type,
                       st ? st.label : bag.status, b.quotedTotal || 0, b.paid ? 'Yes' : 'No']);
        });
    });
    var csv = '﻿' + rows.map(function (r) {
        return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = 'luggage_' + today() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    lugToast('Exported');
};

// ── init ────────────────────────────────────────────────────────────────────
function init() {
    LC = window.LuggageCore || null;
    load();
    render();
    console.log('[Luggage] Ready —', lug.bookings.length, 'bookings,', lug.locations.length, 'locations');
}

// Luggage shares Go's page, so it renders when its tab is shown.
window.CampistryGoLuggage = {
    show: function () { if (!LC) init(); else { load(); render(); } },
    refresh: function () { load(); render(); }
};

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('campistry-cloud-hydrated', function () { load(); render(); });
})();
