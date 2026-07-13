// =============================================================================
// campistry_snacks_pos.js — Campistry Snacks Selling Console Logic
// Handles: Camper selection, Quick Push POS, Cart, Charge
//
// DATA SOURCES:
//   Campers: campGlobalSettings_v1 → app1.camperRoster (from Campistry Me)
//   Snacks data: campGlobalSettings_v1 → campistrySnacks (shared with manager)
// =============================================================================

(function() {
'use strict';

console.log('[Snacks POS] Loading...');

const STORE_KEY = 'campGlobalSettings_v1';
const SNACKS_LOCAL_KEY = 'campistry_snacks_data';

// ==========================================================================
// DATA LAYER — same as manager, reads from Me + Snacks store
// ==========================================================================

function readGlobal() {
    // STORE_KEY (campGlobalSettings_v1) is what campistry_cloud_bootstrap.js
    // actually hydrates from Supabase into — it must be checked FIRST.
    // CAMPISTRY_UNIFIED_STATE is only ever written by demo_mode.js (offline
    // expo mode) or the standalone registration page; checking it first meant
    // a stale/demo value left in this browser's localStorage would
    // permanently shadow the real, freshly-hydrated roster.
    const keys = [STORE_KEY, 'CAMPISTRY_LOCAL_CACHE', 'CAMPISTRY_UNIFIED_STATE'];
    for (const key of keys) {
        try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) || {}; } catch (_) {}
    }
    return {};
}

function getRoster() {
    const g = readGlobal();
    return g?.app1?.camperRoster || {};
}

function getStructure() {
    const g = readGlobal();
    return g?.campStructure || {};
}

function getCamperList() {
    const roster = getRoster();
    const structure = getStructure();
    const campers = [];
    Object.entries(roster).forEach(([name, data]) => {
        let div = data.division || '';
        let bunk = data.bunk || '';
        if (bunk && !div) {
            Object.entries(structure).forEach(([divName, divData]) => {
                Object.values(divData.grades || {}).forEach(grade => {
                    if ((grade.bunks || []).includes(bunk)) div = divName;
                });
            });
        }
        campers.push({ name, division: div, bunk });
    });
    return campers.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSnacksData() {
    const g = readGlobal();
    if (g.campistrySnacks && Object.keys(g.campistrySnacks).length > 0) return g.campistrySnacks;
    try { const raw = localStorage.getItem(SNACKS_LOCAL_KEY); if (raw) return JSON.parse(raw); } catch (_) {}
    return { accounts: {}, inventory: [], transactions: [], hourlyActivity: {}, weeklyRevenue: [] };
}

function saveSnacksData(data) {
    try {
        const g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistrySnacks = data;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) { console.warn('[Snacks POS] Global save failed:', e); }
    try { localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(data)); } catch (_) {}
    cloudSaveSnacks(data);
}

function _txSig(t) { return [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|'); }
function _reconcileBalances(data) {
    if (!data || !data.accounts) return data;
    var byCamper = {};
    (data.transactions || []).forEach(function(t) { if (!t || !t.camper) return; var amt = parseFloat(t.amount) || 0; byCamper[t.camper] = (byCamper[t.camper] || 0) + (t.type === 'credit' ? amt : -amt); });
    Object.keys(data.accounts).forEach(function(name) { if (byCamper[name] != null) data.accounts[name].balance = Math.round(byCamper[name] * 100) / 100; });
    return data;
}
// Cloud write. Fetch-merge so a POS write never clobbers a parent deposit or a
// server-side purchase (submit_canteen_purchase) that hit the cloud after this
// tab cached its copy — union the transaction ledgers and recompute balances
// from the union (the ledger is the source of truth).
function cloudSaveSnacks(data) {
    try {
        const db = window.CampistryDB;
        const client = db && db.getClient ? db.getClient() : (db && db.client);
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId || !client.from) { _cloudUpsertSnacks(data); return; }
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                var cloud = (res && res.data && res.data.value) || null;
                var merged = data;
                if (cloud && typeof cloud === 'object') {
                    var seen = {}, tx = [];
                    (data.transactions || []).concat(cloud.transactions || []).forEach(function(t) { var s = _txSig(t); if (seen[s]) return; seen[s] = 1; tx.push(t); });
                    merged = Object.assign({}, cloud, data);
                    merged.accounts = Object.assign({}, cloud.accounts || {}, data.accounts || {});
                    merged.transactions = tx;
                    _reconcileBalances(merged);
                }
                _cloudUpsertSnacks(merged);
                try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = merged; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                snacks = merged;
            }, function() { _cloudUpsertSnacks(data); });
    } catch (e) { console.warn('[Snacks POS] Cloud save error:', e); _cloudUpsertSnacks(data); }
}
function _cloudUpsertSnacks(data) {
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) { window.saveGlobalSettings('campistrySnacks', data); return; }
    try {
        const db = window.CampistryDB;
        if (!db || !db.client) return;
        const campId = db.getCampId && db.getCampId();
        if (!campId) return;
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistrySnacks', value: data, updated_at: new Date().toISOString() }, { onConflict: 'camp_id,key' })
            .then(res => { if (res.error) console.warn('[Snacks POS] Cloud save failed:', res.error.message); });
    } catch (e) { console.warn('[Snacks POS] Cloud save error:', e); }
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ==========================================================================
// STATE
// ==========================================================================

let snacks = loadSnacksData();
let campers = [];
let sel = null; // selected camper name
let cart = [];
let cat = 'all';

function getAccount(name) {
    if (!snacks.accounts) snacks.accounts = {};
    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    const a = snacks.accounts[name];
    // Daily spend resets at midnight
    if (a.lastSpendDate !== todayStr()) { a.spentToday = 0; a.lastSpendDate = todayStr(); }
    return a;
}

// ==========================================================================
// INIT
// ==========================================================================

function init() {
    campers = getCamperList();
    if (!snacks.accounts) snacks.accounts = {};
    if (!snacks.inventory) snacks.inventory = [];
    if (!snacks.transactions) snacks.transactions = [];

    // Ensure all roster campers have accounts
    campers.forEach(c => {
        if (!snacks.accounts[c.name]) snacks.accounts[c.name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    });

    renderCampers();
    renderItems();
    renderCart();
    console.log('[Snacks POS] Ready —', campers.length, 'campers,', snacks.inventory.length, 'items');

    // Show empty state if no campers
    if (campers.length === 0) {
        document.getElementById('camperList').innerHTML = '<div style="text-align:center;padding:2rem 1rem;color:var(--text-muted);font-size:.8rem">No campers found.<br>Add campers in <a href="campistry_me.html" style="color:var(--snacks)">Campistry Me</a> first.</div>';
    }
    if (snacks.inventory.length === 0) {
        document.getElementById('quickGrid').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:.8rem;grid-column:1/-1">No inventory items.<br>Add items in the <a href="campistry_snacks.html" style="color:var(--snacks)">Manager Dashboard</a>.</div>';
        document.getElementById('allGrid').innerHTML = '';
    }
}

// Clock
function tick() { document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
setInterval(tick, 1000); tick();

// ==========================================================================
// CAMPER PANEL
// ==========================================================================

window.renderCampers = function() {
    const q = (document.getElementById('camperSearch').value || '').toLowerCase();
    const list = campers.filter(c => c.name.toLowerCase().includes(q));
    document.getElementById('camperList').innerHTML = list.map(c => {
        const a = getAccount(c.name);
        const rem = a.dailyLimit - a.spentToday;
        const limitHit = rem <= 0 && a.balance > 0;
        const cls = a.balance <= 0 ? 'empty' : a.balance <= 5 ? 'low' : '';
        const initials = c.name.split(' ').map(w => w[0]).join('');
        return '<div class="camper-item' + (sel === c.name ? ' selected' : '') + (limitHit ? ' limit-hit' : '') +
            '" onclick="pickCamper(\'' + esc(c.name).replace(/'/g, "\\'") + '\')">' +
            '<div class="camper-avatar">' + initials + '</div>' +
            '<div class="camper-info"><div class="camper-name">' + esc(c.name) + '</div>' +
            '<div class="camper-meta">' + esc(c.division) + ' · ' + esc(c.bunk) + (limitHit ? ' · Limit hit' : '') + '</div></div>' +
            '<div class="camper-balance ' + cls + '">$' + a.balance.toFixed(2) + '</div></div>';
    }).join('');
};

window.pickCamper = function(name) {
    sel = name;
    renderCampers();
    updateCamperBar();
    updateChargeBtn();
};

function updateCamperBar() {
    const bar = document.getElementById('cartCamperBar');
    if (!sel) { bar.innerHTML = '<span class="cart-camper-empty">← Select a camper</span>'; return; }
    const a = getAccount(sel);
    const initials = sel.split(' ').map(w => w[0]).join('');
    bar.innerHTML = '<div class="camper-avatar" style="width:28px;height:28px;font-size:.6rem;background:var(--snacks);color:white">' +
        initials + '</div><div class="cart-camper-name">' + esc(sel) + '</div><div class="cart-camper-bal">$' + a.balance.toFixed(2) + '</div>';
}

// ==========================================================================
// ITEM GRID — sorted by popularity, scaled tiles
// ==========================================================================

window.setCat = function(btn, c) { cat = c; document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderItems(); };

window.renderItems = function() {
    const I = snacks.inventory;
    if (!I.length) return;

    const q = (document.getElementById('itemSearch').value || '').toLowerCase();
    const fil = I.filter(i => (cat === 'all' || i.cat === cat) && i.name.toLowerCase().includes(q));
    const sorted = [...fil].sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0));
    const maxT = Math.max(...I.map(i => i.totalSold || 0), 1);

    // Quick push: top 5 in stock
    const quick = sorted.filter(i => i.stock > 0).slice(0, 5);
    document.getElementById('quickGrid').innerHTML = quick.map((i, idx) => {
        let tier = '';
        if (idx === 0) tier = 'hot';
        else if ((i.totalSold || 0) / maxT > .4) tier = 'warm';
        const rank = idx < 3 ? '<div class="tile-rank">🔥 #' + (idx + 1) + '</div>' : '';
        return '<div class="item-tile ' + tier + (i.stock === 0 ? ' out' : '') + '" onclick="addItem(' + i.id + ')">' +
            rank + '<div class="tile-emoji">' + i.emoji + '</div><div class="tile-name">' + esc(i.name) +
            '</div><div class="tile-price">$' + i.price.toFixed(2) + '</div><div class="tile-stock">' +
            (i.stock === 0 ? 'OUT' : i.stock + ' left') + '</div></div>';
    }).join('') || '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.75rem;grid-column:1/-1">No items in stock</div>';

    // All
    document.getElementById('allGrid').innerHTML = sorted.map(i =>
        '<div class="item-tile ' + (i.stock === 0 ? 'out' : '') + '" onclick="addItem(' + i.id + ')">' +
        '<div class="tile-emoji">' + i.emoji + '</div><div class="tile-name">' + esc(i.name) +
        '</div><div class="tile-price">$' + i.price.toFixed(2) + '</div></div>'
    ).join('');
};

window.addItem = function(id) {
    const item = snacks.inventory.find(i => i.id === id);
    if (!item || item.stock === 0) return;
    const ex = cart.find(c => c.id === id);
    if (ex) { if (ex.qty >= item.stock) return; ex.qty++; } else cart.push({ id, qty: 1 });
    renderCart();
};

// ==========================================================================
// CART
// ==========================================================================

window.clearCart = function() { cart = []; renderCart(); };
window.changeQty = function(id, d) {
    const ci = cart.find(c => c.id === id);
    if (!ci) return;
    ci.qty += d;
    if (ci.qty <= 0) cart = cart.filter(c => c.id !== id);
    renderCart();
};

function renderCart() {
    const body = document.getElementById('cartBody');
    const totalEl = document.getElementById('cartTotal');
    const remEl = document.getElementById('cartRemaining');
    if (!cart.length) {
        body.innerHTML = '<div class="cart-empty">Tap items to start</div>';
        totalEl.textContent = '$0.00';
        remEl.textContent = '';
        updateChargeBtn();
        return;
    }
    let total = 0;
    body.innerHTML = cart.map(ci => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        if (!item) return '';
        const lt = item.price * ci.qty; total += lt;
        return '<div class="cart-line"><div class="cart-line-info"><div class="cart-line-name">' + item.emoji + ' ' + esc(item.name) +
            '</div><div class="cart-line-sub">$' + item.price.toFixed(2) + ' ea</div></div>' +
            '<div class="cart-line-qty"><button onclick="changeQty(' + ci.id + ',-1)">−</button><span>' + ci.qty +
            '</span><button onclick="changeQty(' + ci.id + ',1)">+</button></div>' +
            '<div class="cart-line-total">$' + lt.toFixed(2) + '</div></div>';
    }).join('');
    totalEl.textContent = '$' + total.toFixed(2);
    if (sel) {
        const a = getAccount(sel);
        const rem = a.dailyLimit - a.spentToday;
        remEl.textContent = 'Daily remaining: $' + Math.max(rem, 0).toFixed(2) + ' · Balance: $' + a.balance.toFixed(2);
    }
    updateChargeBtn();
}

function updateChargeBtn() {
    const btn = document.getElementById('chargeBtn');
    const total = cart.reduce((s, ci) => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        return s + (item ? item.price * ci.qty : 0);
    }, 0);
    if (!sel || !cart.length || total === 0) { btn.disabled = true; btn.textContent = 'Charge'; return; }
    btn.disabled = false;
    btn.textContent = 'Charge $' + total.toFixed(2) + ' → ' + sel.split(' ')[0];
}

// ==========================================================================
// CHARGE — deducts balance, decrements stock, logs transaction
// ==========================================================================

window.charge = function() {
    if (!sel || !cart.length) return;
    const a = getAccount(sel);
    const total = Math.round(cart.reduce((s, ci) => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        return s + (item ? item.price * ci.qty : 0);
    }, 0) * 100) / 100;
    const itemNames = cart.map(ci => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        if (!item) return '';
        return ci.qty > 1 ? item.name + ' ×' + ci.qty : item.name;
    }).filter(Boolean).join(', ');

    // Fast client-side PRE-check (UX only — the server RPC is the authority).
    const rem = a.dailyLimit - a.spentToday;
    if (a.dailyLimit > 0 && total > rem) { toast('Exceeds daily limit ($' + Math.max(rem,0).toFixed(2) + ' left)', true); return; }
    const spendable = a.balance - (a.balanceFloor || 0) + (a.creditLimit || 0);
    if (total > spendable) { toast('Insufficient balance ($' + spendable.toFixed(2) + ' spendable)', true); return; }

    // ── AUTHORITATIVE PATH: submit_canteen_purchase enforces the parent's daily
    // limit + overdraft atomically under a row lock (migration 026). This is the
    // ONE place caps are guaranteed — a client bypass or a race can't overspend.
    const _cdb = window.CampistryDB;
    const client = _cdb && _cdb.getClient && _cdb.getClient();
    const campId = _cdb && _cdb.getCampId && _cdb.getCampId();
    const finish = () => {
        // Inventory + activity are POS-local; the RPC already logged the debit
        // transaction and the new balance, so we do NOT add a transaction here.
        cart.forEach(ci => { const item = snacks.inventory.find(i => i.id === ci.id); if (item) { item.stock -= ci.qty; item.soldToday = (item.soldToday || 0) + ci.qty; item.totalSold = (item.totalSold || 0) + ci.qty; } });
        if (!snacks.hourlyActivity) snacks.hourlyActivity = {};
        const hr = new Date().getHours(); snacks.hourlyActivity[hr] = (snacks.hourlyActivity[hr] || 0) + 1;
        saveSnacksData(snacks); // fetch-merges: pulls the RPC's debit into the ledger, reconciles balance
        const cp = document.querySelector('.cart-panel'); if (cp) { cp.classList.add('flash'); setTimeout(() => cp.classList.remove('flash'), 600); }
        toast('✓ $' + total.toFixed(2) + ' charged to ' + sel);
        cart = []; sel = null;
        renderCampers(); renderItems(); renderCart(); updateCamperBar();
        var cs = document.getElementById('camperSearch'); if (cs) { cs.value = ''; cs.focus(); }
    };

    // Best-effort local charge (offline, or before the purchase RPC exists).
    // Enforcement is the client pre-check above; the ledger reconciles later.
    const localCharge = () => {
        a.balance = Math.round((a.balance - total) * 100) / 100;
        a.spentToday = Math.round((a.spentToday + total) * 100) / 100;
        a.lastSpendDate = todayStr();
        if (!snacks.transactions) snacks.transactions = [];
        snacks.transactions.unshift({ time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), camper: sel, items: itemNames, amount: total, type: 'debit', date: todayStr() });
        finish();
    };

    if (client && campId && client.rpc) {
        const camperName = sel;
        client.rpc('submit_canteen_purchase', { p_camp_id: campId, p_camper_name: camperName, p_amount: total, p_items: itemNames, p_date: todayStr() })
            .then(res => {
                const d = res && res.data;
                const emsg = (res.error && res.error.message) || '';
                // Migration 026 not applied yet → RPC doesn't exist → don't break
                // the register; fall back to the local path.
                if (res.error && /PGRST202|could not find|schema cache|does not exist|no function/i.test(emsg)) { localCharge(); return; }
                if (res.error || !d || !d.success) {
                    const err = (d && d.error) || emsg || 'charge_failed';
                    const msg = err === 'daily_limit_exceeded' ? 'Blocked — over daily limit ($' + (Number((d && d.remaining) || 0)).toFixed(2) + ' left today)'
                              : err === 'insufficient_balance' ? 'Blocked — insufficient balance ($' + (Number((d && d.spendable) || 0)).toFixed(2) + ' spendable)'
                              : err === 'not_authorized' ? 'Not authorized to charge this camp'
                              : 'Charge failed (' + err + ')';
                    toast(msg, true);
                    return;
                }
                a.balance = Number(d.balance); a.spentToday = Number(d.spentToday); a.lastSpendDate = todayStr();
                finish();
            }, e => { toast('Charge failed — connection error', true); });
        return;
    }

    localCharge();
};

// ==========================================================================
// UTILS
// ==========================================================================

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(msg, err) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (err ? ' err' : '');
    setTimeout(() => el.className = 'toast', 2200);
}

document.addEventListener('DOMContentLoaded', init);

// Re-init after cloud hydration or when another tab (admin / parent portal) writes
window.CampistrySnacksPOS = {
    reinit: function() { snacks = loadSnacksData(); init(); }
};
// The roster and campistrySnacks data both hydrate from the cloud
// asynchronously, shortly AFTER DOMContentLoaded fires — init() above runs
// before that lands, so on a fresh page load the camper list was empty and
// nothing ever re-ran init() afterward. Re-run once hydration completes.
window.addEventListener('campistry-cloud-hydrated', function() {
    console.log('[Snacks POS] Cloud hydrated — reloading roster + snacks data');
    snacks = loadSnacksData();
    init();
});
window.addEventListener('storage', function(e) {
    if (e.key === STORE_KEY || e.key === 'CAMPISTRY_LOCAL_CACHE') {
        snacks = loadSnacksData();
        renderCampers(); renderItems(); renderCart();
    }
});
})();
