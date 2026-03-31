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
    const keys = ['CAMPISTRY_UNIFIED_STATE', STORE_KEY, 'CAMPISTRY_LOCAL_CACHE'];
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
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistrySnacks', data);
    }
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
    return snacks.accounts[name];
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
    const total = cart.reduce((s, ci) => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        return s + (item ? item.price * ci.qty : 0);
    }, 0);
    const rem = a.dailyLimit - a.spentToday;
    if (total > rem) { toast('Exceeds daily limit ($' + rem.toFixed(2) + ' left)', true); return; }
    if (total > a.balance) { toast('Insufficient balance ($' + a.balance.toFixed(2) + ')', true); return; }

    // Process
    a.balance -= total;
    a.spentToday += total;
    const itemNames = cart.map(ci => {
        const item = snacks.inventory.find(i => i.id === ci.id);
        if (!item) return '';
        item.stock -= ci.qty;
        item.soldToday = (item.soldToday || 0) + ci.qty;
        item.totalSold = (item.totalSold || 0) + ci.qty;
        return ci.qty > 1 ? item.name + ' ×' + ci.qty : item.name;
    }).filter(Boolean).join(', ');

    // Log transaction
    if (!snacks.transactions) snacks.transactions = [];
    snacks.transactions.unshift({
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        camper: sel,
        items: itemNames,
        amount: total,
        date: todayStr()
    });

    // Track hourly activity
    if (!snacks.hourlyActivity) snacks.hourlyActivity = {};
    const hr = new Date().getHours();
    snacks.hourlyActivity[hr] = (snacks.hourlyActivity[hr] || 0) + 1;

    // Save
    saveSnacksData(snacks);

    // Flash success
    document.querySelector('.cart-panel').classList.add('flash');
    setTimeout(() => document.querySelector('.cart-panel').classList.remove('flash'), 600);

    toast('✓ $' + total.toFixed(2) + ' charged to ' + sel);

    // Reset
    cart = [];
    sel = null;
    renderCampers(); renderItems(); renderCart(); updateCamperBar();
    document.getElementById('camperSearch').value = '';
    document.getElementById('camperSearch').focus();
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
})();
