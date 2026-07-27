// =============================================================================
// campistry_snacks_shop.js — the Camp Shop, inside Campistry Snacks
//
// Swag, tees and camp gear. This lives in Snacks rather than as its own app
// because Snacks IS already the camp's store: it has inventory, camper
// accounts, a POS terminal, a transaction ledger and a payment policy. A
// separate shop would have duplicated every one of those and given the office
// two places to look for "what did this camper buy".
//
// Pricing, variants and stock rules are in campistry_shop_core.js (pure +
// unit tested). This file is storage and rendering only.
//
// DATA — campGlobalSettings_v1 -> campistryShop
//   products: [ { id, sku, name, category, emoji, price, sizes[], colors[],
//                 priceDeltas{size:delta}, stock{variantId:qty}, active } ]
//   orders:   [ { id, camperName, bunk, division, lines[], status, paid,
//                 payMethod, discountPct, discountAmt, taxRate, notes,
//                 placedAt } ]
//   settings: { taxRate, lowStockThreshold }
//
// Campers come from app1.camperRoster (Campistry Me) — which is also where a
// camper's shirt size comes from, so an order pre-selects it.
//
// Mounts itself into #page-shop when Snacks renders that page.
// =============================================================================
(function () {
'use strict';

var STORE_KEY = 'campGlobalSettings_v1';
var SC = null;                 // ShopCore, resolved at init
var shop = { products: [], orders: [], settings: {} };
var tab = 'catalogue';
var editingProduct = null;     // id or null
var editingOrder = null;       // id or null
var draftLines = [];           // lines being edited in the order modal
var restockProduct = null;

// ── storage ─────────────────────────────────────────────────────────────────
function readGlobal() {
    // Same key order as the other apps: the cloud bootstrap hydrates
    // campGlobalSettings_v1, and a stale demo blob must not shadow it.
    var keys = [STORE_KEY, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
    for (var i = 0; i < keys.length; i++) {
        try { var raw = localStorage.getItem(keys[i]); if (raw) return JSON.parse(raw) || {}; } catch (e) {}
    }
    return {};
}
function load() {
    var g = readGlobal();
    var s = g.campistryShop || {};
    shop = {
        products: Array.isArray(s.products) ? s.products : [],
        orders: Array.isArray(s.orders) ? s.orders : [],
        settings: Object.assign({ taxRate: 0, lowStockThreshold: 5 }, s.settings || {})
    };
    // Stable ids — orders reference products by id, so a product without one
    // silently detaches every order that points at it.
    var max = 0;
    shop.products.forEach(function (p) { if (p && +p.id > max) max = +p.id; });
    shop.products.forEach(function (p) { if (p && !p.id) p.id = ++max; });
}
function save() {
    try {
        var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistryShop = shop;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) { console.warn('[Shop] Local save failed:', e); }
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistryShop', shop);
        return;
    }
    try {
        var db = window.CampistryDB;
        var campId = db && db.getCampId && db.getCampId();
        if (!db || !db.client || !campId) return;
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistryShop', value: shop, updated_at: new Date().toISOString() },
                    { onConflict: 'camp_id,key' })
            .then(function (r) { if (r.error) console.warn('[Shop] Cloud save failed:', r.error.message); });
    } catch (e) { console.warn('[Shop] Cloud save error:', e); }
}

function roster() { var g = readGlobal(); return (g.app1 && g.app1.camperRoster) || {}; }
function camperList() {
    var r = roster();
    return Object.keys(r).map(function (name) {
        var c = r[name] || {};
        return { name: name, bunk: c.bunk || '', division: c.division || '', shirtSize: c.shirtSize || '' };
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

// Snacks already has a toast; use it so the Shop doesn't stack a second one
// in a different corner. Falls back to its own if the host's isn't there.
window.shopToast = function (msg, isErr) {
    var host = document.getElementById('toast');
    if (host) {
        host.textContent = msg;
        host.className = 'toast show' + (isErr ? ' err' : '');
        clearTimeout(host._t);
        host._t = setTimeout(function () { host.className = 'toast'; }, 2600);
        return;
    }
    console.log('[Shop]', msg);
};
// Modals are created on demand and removed on close. The standalone page used
// to carry them as static markup; injecting three overlays into the Snacks
// page just so they can sit hidden isn't worth it.
function modal(id, title, bodyHtml, saveLabel, onSave, wide) {
    shopClose(id);
    var ov = document.createElement('div');
    ov.className = 'ops-overlay open';
    ov.id = 'm-' + id;
    ov.setAttribute('data-ops', 'shop');
    ov.innerHTML =
        '<div class="ops-modal' + (wide ? ' ops-modal--lg' : '') + '">' +
            '<div class="ops-modal-head"><h2>' + esc(title) + '</h2>' +
                '<button class="ops-x" data-close="1">&times;</button></div>' +
            '<div class="ops-modal-body" id="' + id + 'Body"></div>' +
            '<div class="ops-modal-foot">' +
                '<button class="ops-btn" data-close="1">Cancel</button>' +
                '<button class="ops-btn ops-btn--pri" id="' + id + 'Save">' + esc(saveLabel) + '</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(ov);
    el(id + 'Body').innerHTML = bodyHtml;
    ov.querySelectorAll('[data-close]').forEach(function (b) {
        b.addEventListener('click', function () { shopClose(id); });
    });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) shopClose(id); });
    el(id + 'Save').addEventListener('click', onSave);
    return ov;
}
window.shopClose = function (n) { var e = el('m-' + n); if (e) e.remove(); };

function stat(label, value, sub) {
    return '<div class="ops-stat"><div class="ops-stat-label">' + esc(label) + '</div>' +
        '<div class="ops-stat-value">' + value + '</div>' +
        (sub ? '<div class="ops-stat-sub">' + esc(sub) + '</div>' : '') + '</div>';
}
function empty(msg, cta) {
    return '<div class="ops-empty"><p>' + esc(msg) + '</p>' + (cta || '') + '</div>';
}
function productById(id) {
    return shop.products.filter(function (p) { return String(p.id) === String(id); })[0] || null;
}
function orderById(id) {
    return shop.orders.filter(function (o) { return String(o.id) === String(id); })[0] || null;
}

// ── render ──────────────────────────────────────────────────────────────────
var TABS = [
    { k: 'catalogue', l: 'Catalogue' },
    { k: 'orders', l: 'Orders' },
    { k: 'fulfil', l: 'Fulfilment' },
    { k: 'inventory', l: 'Inventory' },
    { k: 'reports', l: 'Reports' }
];

window.shopTab = function (t) { tab = t; render(); };

/**
 * Build the section shell inside the host page, once. Snacks renders
 * #page-shop; everything below hangs off the nodes created here.
 */
function mount() {
    var host = el('page-shop');
    if (!host) return false;
    if (!el('shopBody')) {
        host.innerHTML =
            '<div data-ops="shop">' +
                '<div class="ops-hero">' +
                    '<div class="ops-hero-icon">' +
                        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>' +
                    '</div>' +
                    '<div><h1>Camp Shop</h1><p>Swag, tees and camp gear — catalogue, orders and fulfilment</p></div>' +
                    '<div class="ops-hero-actions">' +
                        '<button class="ops-btn" onclick="shopExportCSV()">&darr; Export orders</button>' +
                        '<button class="ops-btn ops-btn--pri" onclick="shopNewOrder()">+ New Order</button>' +
                    '</div>' +
                '</div>' +
                '<div class="ops-tabs" id="shopTabs"></div>' +
                '<div id="shopBody"></div>' +
            '</div>';
    }
    return true;
}

function render() {
    if (!mount()) return;
    var tabsEl = el('shopTabs');
    if (tabsEl) {
        tabsEl.innerHTML = TABS.map(function (t) {
            return '<button class="ops-tab' + (tab === t.k ? ' active' : '') + '" onclick="shopTab(\'' + t.k + '\')">' + t.l + '</button>';
        }).join('');
    }
    var body = el('shopBody');
    if (!body) return;
    if (!SC) { body.innerHTML = '<div class="ops-empty"><p>Shop engine didn\'t load — reload the page.</p></div>'; return; }
    body.innerHTML =
        tab === 'catalogue' ? renderCatalogue()
      : tab === 'orders' ? renderOrders()
      : tab === 'fulfil' ? renderFulfil()
      : tab === 'inventory' ? renderInventory()
      : renderReports();
}

function renderCatalogue() {
    var rev = SC.revenue(shop.orders, shop.products);
    var h = '<div class="ops-stats">' +
        stat('Products', shop.products.length, '') +
        stat('Orders', rev.orders, '') +
        stat('Collected', money(rev.collected), '') +
        stat('Outstanding', money(rev.outstanding), rev.outstanding > 0 ? 'Not yet paid' : '') +
        '</div>';

    h += '<div class="ops-card-head" style="padding:0 0 10px;border:none">' +
        '<h2>Catalogue</h2>' +
        '<button class="ops-btn ops-btn--pri ops-btn--sm" onclick="shopEditProduct()">+ Add Product</button></div>';

    if (!shop.products.length) {
        return h + empty('Nothing in the shop yet. Add a tee, a hoodie or a hat to get started.',
            '<button class="ops-btn ops-btn--pri" onclick="shopEditProduct()">+ Add Product</button>');
    }

    h += '<div class="ops-grid">';
    shop.products.forEach(function (p) {
        var total = SC.totalStock(p);
        var low = SC.lowStockVariants(p, shop.settings.lowStockThreshold);
        var cat = SC.CATEGORIES.filter(function (c) { return c.id === p.category; })[0];
        h += '<div class="ops-prod" onclick="shopEditProduct(' + p.id + ')">' +
            '<div class="ops-prod-emoji">' + esc(p.emoji || '👕') + '</div>' +
            '<div class="ops-prod-name">' + esc(p.name || 'Untitled') + '</div>' +
            '<div class="ops-prod-meta">' + esc(cat ? cat.label : (p.category || '')) +
                ' · ' + (p.sizes || []).length + ' size' + ((p.sizes || []).length === 1 ? '' : 's') +
                ((p.colors || []).length > 1 ? ' · ' + p.colors.length + ' colours' : '') + '</div>' +
            '<div class="ops-prod-price">' + money(p.price) + '</div>' +
            '<div style="margin-top:8px">' +
                (total === 0 ? '<span class="ops-badge ops-badge--err">Out of stock</span>'
                 : low.length ? '<span class="ops-badge ops-badge--warn">' + low.length + ' low</span>'
                 : '<span class="ops-badge ops-badge--ok">' + total + ' in stock</span>') +
                (p.active === false ? ' <span class="ops-badge">Hidden</span>' : '') +
            '</div></div>';
    });
    h += '</div>';
    return h;
}

function renderOrders() {
    if (!shop.orders.length) {
        return empty('No orders yet.', '<button class="ops-btn ops-btn--pri" onclick="shopNewOrder()">+ New Order</button>');
    }
    var rev = SC.revenue(shop.orders, shop.products);
    var h = '<div class="ops-stats">' +
        stat('Orders', rev.orders, '') +
        stat('Collected', money(rev.collected), '') +
        stat('Outstanding', money(rev.outstanding), '') +
        stat('Total', money(rev.total), '') +
        '</div>';

    h += '<div class="ops-card"><div class="ops-card-head"><h2>All Orders</h2>' +
        '<button class="ops-btn ops-btn--pri ops-btn--sm" onclick="shopNewOrder()">+ New Order</button></div>' +
        '<div class="ops-tw"><table class="ops-t"><thead><tr>' +
        '<th>Camper</th><th>Bunk</th><th>Items</th><th class="num">Total</th><th>Paid by</th><th>Status</th><th></th></tr></thead><tbody>';

    shop.orders.slice().sort(function (a, b) { return String(b.placedAt || '').localeCompare(String(a.placedAt || '')); })
        .forEach(function (o) {
            var t = SC.orderTotals(o, shop.products);
            var badge = o.status === 'cancelled' ? 'ops-badge--err'
                      : o.status === 'delivered' ? 'ops-badge--ok'
                      : o.status === 'packed' ? 'ops-badge--info' : '';
            h += '<tr class="click" onclick="shopEditOrder(\'' + esc(o.id) + '\')">' +
                '<td class="bold">' + esc(o.camperName || '—') + '</td>' +
                '<td>' + esc(o.bunk || '—') + '</td>' +
                '<td>' + t.itemCount + '</td>' +
                '<td class="num">' + money(t.total) + '</td>' +
                '<td>' + esc(payLabel(o.payMethod)) + (o.paid ? '' : ' <span class="ops-badge ops-badge--warn">unpaid</span>') + '</td>' +
                '<td><span class="ops-badge ' + badge + '">' + esc(SC.STATUS_LABELS[o.status] || o.status) + '</span></td>' +
                '<td style="text-align:right" onclick="event.stopPropagation()">' +
                    '<button class="ops-btn ops-btn--sm ops-btn--danger" onclick="shopDeleteOrder(\'' + esc(o.id) + '\')">✕</button></td></tr>';
        });
    h += '</tbody></table></div></div>';
    return h;
}
function payLabel(id) {
    var m = SC.PAY_METHODS.filter(function (x) { return x.id === id; })[0];
    return m ? m.label : '—';
}

function renderFulfil() {
    var groups = SC.pickListByBunk(shop.orders);
    if (!groups.length) return empty('Nothing to hand out yet.');
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none">' +
        '<h2>Pick List by Bunk</h2>' +
        '<button class="ops-btn ops-btn--sm" onclick="window.print()">Print</button></div>';
    h += '<p class="ops-note" style="margin:0 0 14px">Cancelled orders are left out. Anything without a bunk is grouped at the bottom so it can\'t quietly go undelivered.</p>';

    groups.forEach(function (g) {
        h += '<div class="ops-card"><div class="ops-card-head"><h3>' + esc(g.bunk) + '</h3>' +
            '<span class="ops-badge">' + g.items + ' item' + (g.items === 1 ? '' : 's') + ' · ' + g.orders.length + ' order' + (g.orders.length === 1 ? '' : 's') + '</span></div>' +
            '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Camper</th><th>Items</th><th>Status</th><th></th></tr></thead><tbody>';
        g.orders.forEach(function (o) {
            var items = (o.lines || []).map(function (l) {
                return esc(l.name || 'Item') + (l.size ? ' · ' + esc(SC.SIZE_LABELS[l.size] || l.size) : '') +
                    (l.color ? ' · ' + esc(l.color) : '') + ' ×' + (parseInt(l.qty, 10) || 0);
            }).join('<br>');
            h += '<tr><td class="bold">' + esc(o.camperName || '—') + '</td>' +
                '<td style="font-size:.8rem">' + items + '</td>' +
                '<td><span class="ops-badge">' + esc(SC.STATUS_LABELS[o.status] || o.status) + '</span></td>' +
                '<td style="text-align:right">' +
                    (o.status !== 'delivered' && o.status !== 'cancelled'
                        ? '<button class="ops-btn ops-btn--sm" onclick="shopAdvance(\'' + esc(o.id) + '\')">' +
                          (o.status === 'packed' ? 'Mark delivered' : 'Mark packed') + '</button>'
                        : '') + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
    });
    return h;
}

window.shopAdvance = function (id) {
    var o = orderById(id); if (!o) return;
    o.status = (o.status === 'packed') ? 'delivered' : 'packed';
    save(); render();
    shopToast('Marked ' + SC.STATUS_LABELS[o.status].toLowerCase());
};

function renderInventory() {
    if (!shop.products.length) return empty('Add a product first.');
    var threshold = shop.settings.lowStockThreshold;
    var h = '<div class="ops-card-head" style="padding:0 0 10px;border:none"><h2>Stock by Variant</h2>' +
        '<div style="display:flex;gap:8px;align-items:center"><label class="ops-hint">Low-stock at</label>' +
        '<input class="ops-input" style="width:70px" type="number" min="0" value="' + threshold + '" onchange="shopSetThreshold(this.value)"></div></div>';

    shop.products.forEach(function (p) {
        var vs = SC.variants(p);
        h += '<div class="ops-card"><div class="ops-card-head"><h3>' + esc(p.emoji || '👕') + ' ' + esc(p.name) + '</h3>' +
            '<button class="ops-btn ops-btn--sm" onclick="shopRestock(' + p.id + ')">Restock</button></div>' +
            '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Variant</th><th class="num">Price</th><th class="num">In stock</th><th>Status</th></tr></thead><tbody>';
        vs.forEach(function (v) {
            h += '<tr><td class="bold">' + esc(v.label) + '</td>' +
                '<td class="num">' + money(v.price) + '</td>' +
                '<td class="num">' + v.stock + '</td>' +
                '<td>' + (v.stock === 0 ? '<span class="ops-badge ops-badge--err">Out</span>'
                        : v.stock <= threshold ? '<span class="ops-badge ops-badge--warn">Low</span>'
                        : '<span class="ops-badge ops-badge--ok">OK</span>') + '</td></tr>';
        });
        h += '</tbody></table></div></div>';
    });
    return h;
}
window.shopSetThreshold = function (v) {
    shop.settings.lowStockThreshold = Math.max(0, parseInt(v, 10) || 0);
    save(); render();
};

function renderReports() {
    if (!shop.orders.length) return empty('No orders yet — reports fill in once things start selling.');
    var rev = SC.revenue(shop.orders, shop.products);
    var sizes = SC.sizeBreakdown(shop.orders);
    var top = SC.topSellers(shop.orders, shop.products);

    var h = '<div class="ops-stats">' +
        stat('Revenue', money(rev.total), rev.orders + ' orders') +
        stat('Collected', money(rev.collected), '') +
        stat('Outstanding', money(rev.outstanding), '') +
        stat('Units', top.reduce(function (s, t) { return s + t.qty; }, 0), '') +
        '</div>';

    // The number a camp actually needs when placing a print run.
    h += '<div class="ops-card"><div class="ops-card-head"><h2>Size Breakdown</h2>' +
        '<span class="ops-badge ops-badge--info">Use this for your print run</span></div>';
    if (!sizes.length) h += '<div class="ops-card-body ops-note">Nothing ordered yet.</div>';
    else {
        var maxQty = sizes.reduce(function (m, s) { return Math.max(m, s.qty); }, 1);
        h += '<div class="ops-card-body">';
        sizes.forEach(function (s) {
            h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">' +
                '<div style="width:90px;font-size:.78rem;font-weight:600;color:var(--ops-muted);text-align:right">' + esc(s.label) + '</div>' +
                '<div style="flex:1;height:20px;background:var(--ops-line-soft);border-radius:4px;overflow:hidden">' +
                    '<div style="width:' + Math.round(s.qty / maxQty * 100) + '%;height:100%;background:var(--ops-accent);border-radius:4px"></div></div>' +
                '<div style="width:44px;font-size:.8rem;font-weight:700;text-align:right">' + s.qty + '</div></div>';
        });
        h += '</div>';
    }
    h += '</div>';

    h += '<div class="ops-card"><div class="ops-card-head"><h2>Top Sellers</h2></div>' +
        '<div class="ops-tw"><table class="ops-t"><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead><tbody>';
    top.forEach(function (t) {
        h += '<tr><td class="bold">' + esc(t.name || 'Item') + '</td><td class="num">' + t.qty + '</td><td class="num">' + money(t.revenue) + '</td></tr>';
    });
    h += '</tbody></table></div></div>';
    return h;
}

// ── product editor ──────────────────────────────────────────────────────────
window.shopEditProduct = function (id) {
    editingProduct = (id == null) ? null : id;
    var p = editingProduct != null ? (productById(editingProduct) || {}) : {};

    var sizes = p.sizes || ['YM', 'YL', 'AS', 'AM', 'AL', 'AXL'];
    var deltas = p.priceDeltas || {};

    var h = '<div class="ops-fsec">Product</div>' +
        '<div class="ops-row"><div class="ops-field"><label>Name</label><input class="ops-input" id="pName" value="' + esc(p.name || '') + '" placeholder="Camp Tee"></div>' +
        '<div class="ops-field"><label>Emoji</label><input class="ops-input" id="pEmoji" maxlength="4" style="text-align:center;font-size:1.3rem" value="' + esc(p.emoji || '👕') + '"></div></div>' +
        '<div class="ops-row"><div class="ops-field"><label>Category</label><select class="ops-select" id="pCat">' +
            SC.CATEGORIES.map(function (c) { return '<option value="' + c.id + '"' + (p.category === c.id ? ' selected' : '') + '>' + c.label + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="ops-field"><label>Base price ($)</label><input class="ops-input" id="pPrice" type="number" min="0" step="0.25" value="' + (p.price != null ? p.price : '') + '"></div>' +
        '<div class="ops-field"><label>SKU</label><input class="ops-input" id="pSku" value="' + esc(p.sku || '') + '" placeholder="TEE"></div></div>' +
        '<div class="ops-field"><label class="ops-check"><input type="checkbox" id="pActive"' + (p.active !== false ? ' checked' : '') + '> Show in the shop</label></div>';

    h += '<div class="ops-fsec">Sizes</div>' +
        '<div class="ops-chips" id="pSizes">' +
        SC.SIZES.map(function (s) {
            return '<button type="button" class="ops-chip' + (sizes.indexOf(s) >= 0 ? ' on' : '') + '" data-size="' + s + '" onclick="this.classList.toggle(\'on\');shopSyncDeltas()">' + esc(s) + '</button>';
        }).join('') + '</div>' +
        '<p class="ops-hint" style="margin-top:5px">Leave every size off for a one-size item like a hat.</p>';

    // Per-size uplift — a 2XL almost always costs more, and burying that in a
    // separate product would split the reporting for one design.
    h += '<div class="ops-fsec">Price Uplift by Size</div><div id="pDeltas"></div>';

    h += '<div class="ops-fsec">Colours</div>' +
        '<div class="ops-field"><input class="ops-input" id="pColors" value="' + esc((p.colors || []).join(', ')) + '" placeholder="Navy, White, Grey">' +
        '<span class="ops-hint">Comma separated. Leave blank for a single colour.</span></div>';

    modal('prod', editingProduct != null ? 'Edit Product' : 'Add Product',
          h, 'Save Product', shopSaveProduct);
    shopSyncDeltas(deltas);
};

window.shopSyncDeltas = function (existing) {
    var deltas = existing || {};
    if (!existing && editingProduct != null) {
        var p = productById(editingProduct);
        if (p) deltas = p.priceDeltas || {};
    }
    var picked = Array.prototype.slice.call(document.querySelectorAll('#pSizes .ops-chip.on'))
        .map(function (b) { return b.dataset.size; });
    var box = el('pDeltas');
    if (!box) return;
    if (!picked.length) { box.innerHTML = '<p class="ops-hint">Pick some sizes first.</p>'; return; }
    box.innerHTML = '<div class="ops-row" style="flex-wrap:wrap">' + picked.map(function (s) {
        return '<div class="ops-field" style="min-width:100px"><label>' + esc(s) + '</label>' +
            '<input class="ops-input" data-delta="' + s + '" type="number" step="0.25" value="' + (deltas[s] || '') + '" placeholder="0"></div>';
    }).join('') + '</div>' +
    '<p class="ops-hint">Added to the base price for that size — e.g. 3 for a 2XL.</p>';
};

window.shopSaveProduct = function () {
    var name = val('pName');
    if (!name) { shopToast('Name is required', 1); return; }
    var price = num('pPrice');
    var sizes = Array.prototype.slice.call(document.querySelectorAll('#pSizes .ops-chip.on'))
        .map(function (b) { return b.dataset.size; });
    var deltas = {};
    document.querySelectorAll('#pDeltas input[data-delta]').forEach(function (i) {
        var v = parseFloat(i.value);
        if (isFinite(v) && v !== 0) deltas[i.dataset.delta] = v;
    });
    var colors = val('pColors').split(',').map(function (c) { return c.trim(); }).filter(Boolean);

    var existing = editingProduct != null ? productById(editingProduct) : null;
    var rec = {
        id: existing ? existing.id : (shop.products.reduce(function (m, p) { return Math.max(m, +p.id || 0); }, 0) + 1),
        sku: val('pSku') || SC.slug(name).toUpperCase().slice(0, 6),
        name: name,
        category: val('pCat') || 'tees',
        emoji: val('pEmoji') || '👕',
        price: price,
        sizes: sizes,
        colors: colors,
        priceDeltas: deltas,
        // Stock is keyed by variant id and carried over untouched — editing a
        // product must never wipe the counts already recorded against it.
        stock: existing ? (existing.stock || {}) : {},
        active: checked('pActive')
    };
    if (existing) {
        var i = shop.products.findIndex(function (p) { return String(p.id) === String(existing.id); });
        shop.products[i] = Object.assign({}, existing, rec);
    } else shop.products.push(rec);

    save(); shopClose('prod'); render();
    shopToast(existing ? 'Product updated' : 'Product added');
};

// ── restock ─────────────────────────────────────────────────────────────────
window.shopRestock = function (id) {
    restockProduct = id;
    var p = productById(id); if (!p) return;
    var vs = SC.variants(p);
    var h = '<p class="ops-note" style="margin:0 0 12px">Set the count you have on hand for ' +
        esc(p.name) + '.</p>' +
        vs.map(function (v) {
            return '<div class="ops-field" style="flex-direction:row;align-items:center;gap:10px">' +
                '<label style="flex:1;margin:0">' + esc(v.label) + '</label>' +
                '<input class="ops-input" style="width:100px" type="number" min="0" data-vid="' + esc(v.id) + '" value="' + v.stock + '"></div>';
        }).join('');
    modal('shopRestock', 'Restock', h, 'Save Stock', shopSaveRestock);
};
window.shopSaveRestock = function () {
    var p = productById(restockProduct); if (!p) return;
    var stock = Object.assign({}, p.stock || {});
    document.querySelectorAll('#shopRestockBody input[data-vid]').forEach(function (i) {
        stock[i.dataset.vid] = Math.max(0, parseInt(i.value, 10) || 0);
    });
    p.stock = stock;
    save(); shopClose('shopRestock'); render();
    shopToast('Stock updated');
};

// ── order editor ────────────────────────────────────────────────────────────
window.shopNewOrder = function () { shopEditOrder(null); };

window.shopEditOrder = function (id) {
    if (!shop.products.length) { shopToast('Add a product first', 1); return; }
    editingOrder = id || null;
    var o = editingOrder ? (orderById(editingOrder) || {}) : {};
    draftLines = (o.lines || []).map(function (l) { return Object.assign({}, l); });

    var campers = camperList();
    var h = '<div class="ops-fsec">Who</div>' +
        '<div class="ops-row"><div class="ops-field"><label>Camper</label>' +
        '<select class="ops-select" id="oCamper" onchange="shopCamperPicked()">' +
        '<option value="">— Select —</option>' +
        campers.map(function (c) {
            return '<option value="' + esc(c.name) + '"' + (o.camperName === c.name ? ' selected' : '') + '>' +
                esc(c.name) + (c.bunk ? ' (' + esc(c.bunk) + ')' : '') + '</option>';
        }).join('') + '</select></div>' +
        '<div class="ops-field"><label>Bunk</label><input class="ops-input" id="oBunk" value="' + esc(o.bunk || '') + '"></div></div>';

    h += '<div class="ops-fsec">Items</div><div id="oLines"></div>' +
        '<button class="ops-btn ops-btn--sm" onclick="shopAddLine()">+ Add item</button>';

    h += '<div class="ops-fsec">Payment</div>' +
        '<div class="ops-row"><div class="ops-field"><label>Method</label><select class="ops-select" id="oPay">' +
            '<option value="">— Not set —</option>' +
            SC.PAY_METHODS.map(function (m) { return '<option value="' + m.id + '"' + (o.payMethod === m.id ? ' selected' : '') + '>' + m.label + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="ops-field"><label>Status</label><select class="ops-select" id="oStatus">' +
            SC.ORDER_STATUSES.map(function (s) { return '<option value="' + s + '"' + ((o.status || 'placed') === s ? ' selected' : '') + '>' + SC.STATUS_LABELS[s] + '</option>'; }).join('') +
        '</select></div></div>' +
        '<p class="ops-hint" style="margin:-6px 0 10px">Credit cards yes, debit no — same as the canteen. "Charge to camp bill" posts the amount to the family\'s account instead of taking money now.</p>' +
        '<div class="ops-row">' +
            '<div class="ops-field"><label>Discount %</label><input class="ops-input" id="oDiscPct" type="number" min="0" max="100" step="1" value="' + (o.discountPct || '') + '" oninput="shopRecalc()"></div>' +
            '<div class="ops-field"><label>Discount $</label><input class="ops-input" id="oDiscAmt" type="number" min="0" step="0.25" value="' + (o.discountAmt || '') + '" oninput="shopRecalc()"></div>' +
            '<div class="ops-field"><label>Tax rate</label><input class="ops-input" id="oTax" type="number" min="0" max="1" step="0.001" value="' + (o.taxRate != null ? o.taxRate : (shop.settings.taxRate || 0)) + '" oninput="shopRecalc()"></div>' +
        '</div>' +
        '<div class="ops-field"><label class="ops-check"><input type="checkbox" id="oPaid"' + (o.paid ? ' checked' : '') + '> Paid in full</label></div>' +
        '<div class="ops-field"><label>Notes</label><textarea class="ops-textarea" id="oNotes">' + esc(o.notes || '') + '</textarea></div>';

    h += '<div id="oTotals" style="margin-top:14px;padding:12px 14px;background:var(--ops-line-soft);border-radius:var(--ops-r-sm)"></div>';
    h += '<div id="oStockWarn"></div>';

    modal('ord', editingOrder ? 'Edit Order' : 'New Order', h, 'Save Order', shopSaveOrder, true);
    if (!draftLines.length) shopAddLine();
    else drawLines();
};

window.shopCamperPicked = function () {
    var name = val('oCamper');
    var c = camperList().filter(function (x) { return x.name === name; })[0];
    if (!c) return;
    var bunk = el('oBunk');
    if (bunk && !bunk.value) bunk.value = c.bunk || '';
    // The roster already knows the camper's shirt size — pre-select it on any
    // line that hasn't had a size chosen yet, rather than making the office
    // look it up.
    if (c.shirtSize) {
        draftLines.forEach(function (l) {
            if (!l.size) {
                var p = productById(l.productId);
                if (p && (p.sizes || []).indexOf(c.shirtSize) >= 0) l.size = c.shirtSize;
            }
        });
        drawLines();
    }
};

window.shopAddLine = function () {
    var first = shop.products[0];
    draftLines.push({ productId: first ? first.id : null, size: '', color: '', qty: 1 });
    drawLines();
};
window.shopRemoveLine = function (i) { draftLines.splice(i, 1); drawLines(); };

window.shopLineChange = function (i, field, value) {
    var l = draftLines[i]; if (!l) return;
    if (field === 'qty') l.qty = Math.max(0, parseInt(value, 10) || 0);
    else if (field === 'productId') { l.productId = value; l.size = ''; l.color = ''; }
    else l[field] = value;
    drawLines();
};

function drawLines() {
    var box = el('oLines'); if (!box) return;
    box.innerHTML = draftLines.map(function (l, i) {
        var p = productById(l.productId) || shop.products[0] || {};
        var sizes = p.sizes || [];
        var colors = p.colors || [];
        return '<div class="ops-row" style="align-items:flex-end;margin-bottom:8px">' +
            '<div class="ops-field" style="flex:2;min-width:150px;margin:0"><label>Product</label>' +
                '<select class="ops-select" onchange="shopLineChange(' + i + ',\'productId\',this.value)">' +
                shop.products.map(function (x) {
                    return '<option value="' + x.id + '"' + (String(x.id) === String(l.productId) ? ' selected' : '') + '>' + esc(x.name) + '</option>';
                }).join('') + '</select></div>' +
            (sizes.length ? '<div class="ops-field" style="margin:0"><label>Size</label>' +
                '<select class="ops-select" onchange="shopLineChange(' + i + ',\'size\',this.value)">' +
                '<option value="">—</option>' +
                sizes.map(function (s) { return '<option value="' + s + '"' + (l.size === s ? ' selected' : '') + '>' + esc(SC.SIZE_LABELS[s] || s) + '</option>'; }).join('') +
                '</select></div>' : '') +
            (colors.length ? '<div class="ops-field" style="margin:0"><label>Colour</label>' +
                '<select class="ops-select" onchange="shopLineChange(' + i + ',\'color\',this.value)">' +
                '<option value="">—</option>' +
                colors.map(function (c) { return '<option value="' + esc(c) + '"' + (l.color === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
                '</select></div>' : '') +
            '<div class="ops-field" style="max-width:80px;margin:0"><label>Qty</label>' +
                '<input class="ops-input" type="number" min="0" value="' + (l.qty || 0) + '" onchange="shopLineChange(' + i + ',\'qty\',this.value)"></div>' +
            '<div style="flex:0 0 auto"><button class="ops-btn ops-btn--sm ops-btn--danger" onclick="shopRemoveLine(' + i + ')">✕</button></div>' +
            '</div>';
    }).join('');
    shopRecalc();
}

function draftOrder() {
    return {
        camperName: val('oCamper'), bunk: val('oBunk'),
        lines: draftLines.map(function (l) {
            var p = productById(l.productId);
            return {
                productId: l.productId,
                name: p ? p.name : '',
                size: l.size || '', color: l.color || '',
                qty: l.qty || 0,
                // Freeze the price onto the line so a later catalogue change
                // doesn't silently re-price an order already placed.
                unitPrice: p ? SC.unitPrice(p, l.size) : 0
            };
        }).filter(function (l) { return l.qty > 0; }),
        discountPct: num('oDiscPct'), discountAmt: num('oDiscAmt'),
        taxRate: num('oTax'), paid: checked('oPaid'),
        payMethod: val('oPay'), status: val('oStatus') || 'placed',
        notes: val('oNotes')
    };
}

window.shopRecalc = function () {
    var o = draftOrder();
    var t = SC.orderTotals(o, shop.products);
    var box = el('oTotals');
    if (box) {
        box.innerHTML =
            '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>Subtotal (' + t.itemCount + ' item' + (t.itemCount === 1 ? '' : 's') + ')</span><strong>' + money(t.subtotal) + '</strong></div>' +
            (t.discount ? '<div style="display:flex;justify-content:space-between;font-size:.83rem;color:var(--ops-ok)"><span>Discount</span><strong>−' + money(t.discount) + '</strong></div>' : '') +
            (t.tax ? '<div style="display:flex;justify-content:space-between;font-size:.83rem"><span>Tax</span><strong>' + money(t.tax) + '</strong></div>' : '') +
            '<div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;margin-top:6px;padding-top:6px;border-top:1px solid var(--ops-line)"><span>Total</span><span>' + money(t.total) + '</span></div>';
    }
    // Warn about stock, but never block: camps routinely take an order they'll
    // fill from the next print run.
    var warn = el('oStockWarn');
    if (warn) {
        var chk = SC.checkStock(o, shop.products);
        warn.innerHTML = chk.ok ? '' :
            '<div style="margin-top:10px;padding:10px 12px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:var(--ops-r-sm);font-size:.8rem;color:#92400E">' +
            '<strong>Short on stock</strong><br>' +
            chk.shortfalls.map(function (s) {
                return esc(s.name) + (s.size ? ' · ' + esc(SC.SIZE_LABELS[s.size] || s.size) : '') +
                    (s.color ? ' · ' + esc(s.color) : '') +
                    ' — ordering ' + s.wanted + ', have ' + s.available;
            }).join('<br>') +
            '<div style="margin-top:4px;opacity:.8">You can still take the order.</div></div>';
    }
};

window.shopSaveOrder = function () {
    var o = draftOrder();
    if (!o.camperName) { shopToast('Pick a camper', 1); return; }
    if (!o.lines.length) { shopToast('Add at least one item', 1); return; }

    var existing = editingOrder ? orderById(editingOrder) : null;
    // Stock moves when an order becomes packed/delivered, and moves back if it
    // is cancelled. Doing it on the transition (not on every save) is what
    // keeps an edited order from deducting twice.
    var wasFulfilled = existing && (existing.status === 'packed' || existing.status === 'delivered');
    var nowFulfilled = (o.status === 'packed' || o.status === 'delivered');

    var rec = Object.assign({}, existing || {}, o, {
        id: existing ? existing.id : ('ord_' + Date.now() + '_' + Math.floor(Math.random() * 1e4)),
        placedAt: (existing && existing.placedAt) || new Date().toISOString()
    });

    if (!wasFulfilled && nowFulfilled) applyStockAcross(rec, -1);
    else if (wasFulfilled && !nowFulfilled) applyStockAcross(existing, 1);

    if (existing) {
        var i = shop.orders.findIndex(function (x) { return x.id === existing.id; });
        shop.orders[i] = rec;
    } else shop.orders.push(rec);

    save(); shopClose('ord'); render();
    shopToast(existing ? 'Order updated' : 'Order saved');
};

function applyStockAcross(order, direction) {
    shop.products.forEach(function (p) {
        var touched = (order.lines || []).some(function (l) { return String(l.productId) === String(p.id); });
        if (touched) p.stock = SC.applyStock(p, order, direction);
    });
}

window.shopDeleteOrder = function (id) {
    var o = orderById(id); if (!o) return;
    if (!confirm('Delete this order for ' + (o.camperName || 'this camper') + '?')) return;
    // Put the stock back if it had already been taken out.
    if (o.status === 'packed' || o.status === 'delivered') applyStockAcross(o, 1);
    shop.orders = shop.orders.filter(function (x) { return x.id !== id; });
    save(); render();
    shopToast('Order deleted');
};

// ── export ──────────────────────────────────────────────────────────────────
window.shopExportCSV = function () {
    var rows = [['Camper', 'Bunk', 'Product', 'Size', 'Colour', 'Qty', 'Unit', 'Line total', 'Order status', 'Paid', 'Method', 'Placed']];
    shop.orders.forEach(function (o) {
        var t = SC.orderTotals(o, shop.products);
        t.lines.forEach(function (l) {
            rows.push([o.camperName || '', o.bunk || '', l.name, l.size, l.color, l.qty,
                       l.unitPrice, l.lineTotal, SC.STATUS_LABELS[o.status] || o.status,
                       o.paid ? 'Yes' : 'No', payLabel(o.payMethod), (o.placedAt || '').slice(0, 10)]);
        });
    });
    var csv = '﻿' + rows.map(function (r) {
        return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = 'camp_shop_orders_' + today() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    shopToast('Orders exported');
};

// ── init ────────────────────────────────────────────────────────────────────
function init() {
    SC = window.ShopCore || null;
    load();
    render();
    console.log('[Shop] Ready —', shop.products.length, 'products,', shop.orders.length, 'orders');
}

// The Shop shares the Snacks page, so it renders when that page shows it
// rather than on load. snacksNav calls this; init() is idempotent.
window.CampistryShop = {
    show: function () { if (!SC) init(); else { load(); render(); } },
    refresh: function () { load(); render(); }
};

document.addEventListener('DOMContentLoaded', function () {
    // Populate quietly so the tab is instant when the user gets to it. If
    // #page-shop isn't in the DOM yet, mount() no-ops and show() covers it.
    init();
});
// The roster and our own blob both land after DOMContentLoaded.
window.addEventListener('campistry-cloud-hydrated', function () { load(); render(); });
})();
