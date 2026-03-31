// =============================================================================
// campistry_snacks.js — Campistry Snacks Manager Dashboard Logic
// Handles: Accounts, Deposits, Inventory, Restock, Limits, Analytics
//
// DATA SOURCES:
//   Campers: campGlobalSettings_v1 → app1.camperRoster (from Campistry Me)
//   Structure: campGlobalSettings_v1 → campStructure (from Campistry Me)
//   Snacks data: campGlobalSettings_v1 → campistrySnacks (own data)
//     - accounts: { [camperName]: { balance, dailyLimit, spentToday } }
//     - inventory: [ { id, name, cat, emoji, price, stock, soldToday, totalSold } ]
//     - transactions: [ { time, camper, items, amount, date } ]
//     - hourlyActivity: { [hour]: count }
//     - weeklyRevenue: [ { day, amount } ]
// =============================================================================

(function() {
'use strict';

console.log('[Snacks Manager] Loading...');

const STORE_KEY = 'campGlobalSettings_v1';
const SNACKS_LOCAL_KEY = 'campistry_snacks_data'; // fallback

// ==========================================================================
// DATA LAYER — Read from Campistry Me, persist Snacks-specific data
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

// Build flat camper list from roster: [ { name, division, bunk } ]
function getCamperList() {
    const roster = getRoster();
    const structure = getStructure();
    const campers = [];

    Object.entries(roster).forEach(([name, data]) => {
        // Resolve division name from structure if needed
        let div = data.division || '';
        let bunk = data.bunk || '';

        // If bunk is set but division isn't, find it from structure
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

// === SNACKS-SPECIFIC DATA ===

function loadSnacksData() {
    // Priority 1: from global settings (cloud-synced)
    const g = readGlobal();
    if (g.campistrySnacks && Object.keys(g.campistrySnacks).length > 0) {
        return g.campistrySnacks;
    }
    // Priority 2: local fallback
    try {
        const raw = localStorage.getItem(SNACKS_LOCAL_KEY);
        if (raw) return JSON.parse(raw);
    } catch (_) {}
    // Default empty
    return { accounts: {}, inventory: [], transactions: [], hourlyActivity: {}, weeklyRevenue: [] };
}

function saveSnacksData(data) {
    // Write to global settings (for cloud sync)
    try {
        const g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        g.campistrySnacks = data;
        g.updated_at = new Date().toISOString();
        localStorage.setItem(STORE_KEY, JSON.stringify(g));
        localStorage.setItem('CAMPISTRY_LOCAL_CACHE', JSON.stringify(g));
    } catch (e) {
        console.warn('[Snacks] Global save failed, using local fallback:', e);
    }
    // Also write local fallback
    try { localStorage.setItem(SNACKS_LOCAL_KEY, JSON.stringify(data)); } catch (_) {}

    // Cloud sync if bridge available
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistrySnacks', data);
    }
}

// ==========================================================================
// STATE
// ==========================================================================

let snacks = loadSnacksData();
let camperList = [];

function ensureAccountsForRoster() {
    // Create snacks accounts for any campers in the roster that don't have one
    camperList = getCamperList();
    if (!snacks.accounts) snacks.accounts = {};
    let changed = false;
    camperList.forEach(c => {
        if (!snacks.accounts[c.name]) {
            snacks.accounts[c.name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
            changed = true;
        }
    });
    // Remove accounts for campers no longer in roster
    const rosterNames = new Set(camperList.map(c => c.name));
    Object.keys(snacks.accounts).forEach(name => {
        if (!rosterNames.has(name)) { delete snacks.accounts[name]; changed = true; }
    });
    if (changed) saveSnacksData(snacks);
}

function getAccount(name) {
    return snacks.accounts[name] || { balance: 0, dailyLimit: 10, spentToday: 0 };
}

// ==========================================================================
// INIT
// ==========================================================================

function init() {
    ensureAccountsForRoster();
    if (!snacks.inventory) snacks.inventory = [];
    if (!snacks.transactions) snacks.transactions = [];
    if (!snacks.hourlyActivity) snacks.hourlyActivity = {};
    if (!snacks.weeklyRevenue) snacks.weeklyRevenue = [];

    renderStats();
    rAccounts();
    rInventory();
    rAnalytics();
    initTabs();
    popSelects();
    console.log('[Snacks Manager] Ready —', camperList.length, 'campers,', snacks.inventory.length, 'items');
}

function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    }));
}

// ==========================================================================
// STATS
// ==========================================================================

function renderStats() {
    document.getElementById('sA').textContent = camperList.length;
    const totalBal = Object.values(snacks.accounts).reduce((s, a) => s + (a.balance || 0), 0);
    document.getElementById('sB').textContent = '$' + totalBal.toFixed(0);
    document.getElementById('sI').textContent = snacks.inventory.filter(i => i.stock > 0).length;
    const salesToday = (snacks.transactions || []).filter(t => t.date === todayStr()).reduce((s, t) => s + t.amount, 0);
    document.getElementById('sS').textContent = '$' + salesToday.toFixed(0);
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ==========================================================================
// ACCOUNTS TAB
// ==========================================================================

window.rAccounts = function(filter) {
    const q = filter || (document.getElementById('aSearch')?.value || '');
    const items = camperList.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
    document.getElementById('aBody').innerHTML = items.map(c => {
        const a = getAccount(c.name);
        const rem = a.dailyLimit - a.spentToday;
        let st;
        if (a.balance <= 0) st = '<span class="badge badge-red">No Funds</span>';
        else if (rem <= 0) st = '<span class="badge badge-amber">Limit Hit</span>';
        else st = '<span class="badge badge-green">Active</span>';
        return '<tr><td style="font-weight:600">' + esc(c.name) + '</td><td>' + esc(c.division) + '</td><td>' + esc(c.bunk) +
            '</td><td style="font-weight:700;color:' + (a.balance <= 5 ? 'var(--red-600)' : 'var(--text-primary)') + '">$' + a.balance.toFixed(2) +
            '</td><td>$' + a.dailyLimit.toFixed(2) + '</td><td>$' + a.spentToday.toFixed(2) +
            '</td><td>' + st + '</td><td><button class="btn btn-sm btn-primary" onclick="openM(\'dep\');document.getElementById(\'depCamper\').value=\'' +
            esc(c.name) + '\'">+ Deposit</button></td></tr>';
    }).join('');
};

// ==========================================================================
// INVENTORY TAB
// ==========================================================================

function rInventory() {
    const I = snacks.inventory;
    document.getElementById('iCount').textContent = I.length + ' items';
    document.getElementById('iBody').innerHTML = I.map(i => {
        let st;
        if (i.stock === 0) st = '<span class="badge badge-red">Out</span>';
        else if (i.stock <= 10) st = '<span class="badge badge-amber">Low</span>';
        else st = '<span class="badge badge-green">OK</span>';
        return '<tr><td style="font-size:1.2rem;text-align:center;width:36px">' + i.emoji + '</td><td style="font-weight:600">' + esc(i.name) +
            '</td><td><span class="badge badge-neutral">' + i.cat + '</span></td><td style="font-weight:600">$' + i.price.toFixed(2) +
            '</td><td style="font-weight:600;color:' + (i.stock === 0 ? 'var(--red-600)' : i.stock <= 10 ? 'var(--amber-600)' : 'var(--text-primary)') +
            '">' + i.stock + '</td><td>' + (i.soldToday || 0) + '</td><td>' + (i.totalSold || 0) + '</td><td>' + st +
            '</td><td><button class="btn btn-sm btn-secondary">Edit</button></td></tr>';
    }).join('');
}

// ==========================================================================
// ANALYTICS TAB
// ==========================================================================

function rAnalytics() {
    const todayTx = (snacks.transactions || []).filter(t => t.date === todayStr());
    const sal = todayTx.reduce((s, t) => s + t.amount, 0);
    const tc = todayTx.length;
    const I = snacks.inventory;
    const units = I.reduce((s, i) => s + (i.soldToday || 0), 0);
    const openStock = I.reduce((s, i) => s + i.stock + (i.soldToday || 0), 0);

    document.getElementById('mRev').textContent = '$' + sal.toFixed(2);
    document.getElementById('mTxn').textContent = tc + ' txns';
    document.getElementById('mAvg').textContent = tc ? '$' + (sal / tc).toFixed(2) : '$0';
    document.getElementById('mUnits').textContent = units;
    document.getElementById('mLow').textContent = I.filter(i => i.stock <= 10).length;
    document.getElementById('mST').textContent = (openStock ? Math.round(units / openStock * 100) : 0) + '%';

    const top = [...I].sort((a, b) => (b.soldToday || 0) - (a.soldToday || 0))[0];
    document.getElementById('mTop').textContent = top ? top.emoji + ' ' + top.name : '—';
    document.getElementById('mTopN').textContent = top ? (top.soldToday || 0) + ' today · ' + (top.totalSold || 0) + ' all-time' : '';

    // Popularity
    const ranked = [...I].sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0));
    const maxT = ranked[0]?.totalSold || 1;
    document.getElementById('popList').innerHTML = ranked.length ? ranked.map((i, x) =>
        '<div class="rank-item"><div class="rank-pos">' + (x + 1) + '</div><div class="rank-emoji">' + i.emoji +
        '</div><div class="rank-info"><div class="rank-name">' + esc(i.name) +
        '</div><div class="rank-bar-track"><div class="rank-bar-fill" style="width:' + Math.round((i.totalSold || 0) / maxT * 100) +
        '%"></div></div></div><div style="text-align:right"><div class="rank-count">' + (i.totalSold || 0) +
        '</div><div class="rank-revenue">$' + ((i.totalSold || 0) * i.price).toFixed(0) + '</div></div></div>'
    ).join('') : '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Add inventory items to see popularity data</div>';

    // Category breakdown
    const cats = {};
    I.forEach(i => { if (!cats[i.cat]) cats[i.cat] = { u: 0, r: 0 }; cats[i.cat].u += (i.soldToday || 0); cats[i.cat].r += (i.soldToday || 0) * i.price; });
    const cc = { drink: 'var(--blue-500)', snack: 'var(--amber-500)', treat: 'var(--purple-500)' };
    const tr = Object.values(cats).reduce((s, c) => s + c.r, 0) || 1;
    const catHTML = Object.entries(cats).sort((a, b) => b[1].r - a[1].r).map(([k, d]) =>
        '<div class="cat-row"><div class="cat-dot" style="background:' + (cc[k] || 'gray') + '"></div><div class="cat-name">' +
        k.charAt(0).toUpperCase() + k.slice(1) + 's</div><div class="cat-value">$' + d.r.toFixed(2) +
        '</div><div class="cat-pct">' + Math.round(d.r / tr * 100) + '%</div></div>'
    ).join('');
    const barHTML = '<div style="display:flex;gap:3px;margin-top:1rem;height:8px;border-radius:4px;overflow:hidden">' +
        Object.entries(cats).sort((a, b) => b[1].r - a[1].r).map(([k, d]) =>
            '<div style="flex:' + Math.max(Math.round(d.r / tr * 100), 1) + ';background:' + (cc[k] || 'gray') + '"></div>'
        ).join('') + '</div>';
    document.getElementById('catBrk').innerHTML = catHTML ? catHTML + barHTML : '<div style="text-align:center;padding:2rem;color:var(--text-muted)">No sales data yet</div>';

    // Top spenders
    const spenders = camperList.map(c => ({ ...c, spent: getAccount(c.name).spentToday })).filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent);
    document.getElementById('spList').innerHTML = spenders.length ? spenders.map(c =>
        '<div class="spend-row"><div class="spend-avatar">' + c.name.split(' ').map(w => w[0]).join('') +
        '</div><div class="spend-name">' + esc(c.name) + '<div style="font-size:.7rem;color:var(--text-muted)">' + esc(c.division) +
        '</div></div><div class="spend-amount">$' + c.spent.toFixed(2) + '</div></div>'
    ).join('') : '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8rem">No purchases yet today</div>';

    // Hourly heatmap
    const HR = snacks.hourlyActivity || {};
    const hrs = Object.keys(HR).map(Number).sort((a, b) => a - b);
    const maxH = Math.max(...Object.values(HR), 1);
    document.getElementById('heatmap').innerHTML = hrs.length ?
        '<div style="font-size:.75rem;color:var(--text-muted);margin-bottom:.5rem">Darker = busier</div><div style="display:flex;gap:3px;flex-wrap:wrap">' +
        hrs.map(h => {
            const v = HR[h] || 0, p = v / maxH;
            const bg = p > .7 ? 'var(--snacks)' : p > .4 ? 'var(--snacks-100)' : p > 0 ? 'var(--green-50)' : 'var(--bg-tertiary)';
            const clr = p > .7 ? 'white' : 'var(--text-muted)';
            return '<div style="text-align:center"><div class="heat-cell" style="background:' + bg + ';color:' + clr + '">' + v + '</div><div class="heat-label">' + (h > 12 ? h - 12 + 'p' : h + 'a') + '</div></div>';
        }).join('') + '</div>' :
        '<div style="text-align:center;padding:1rem;color:var(--text-muted);font-size:.8rem">Process sales to see hourly patterns</div>';

    // Weekly chart
    const WK = snacks.weeklyRevenue || [];
    if (WK.length) {
        const mx = Math.max(...WK.map(d => d.amount), 1);
        document.getElementById('wChart').innerHTML = WK.map(d =>
            '<div class="bar-col"><div class="bar-value">$' + d.amount + '</div><div class="bar" style="height:' +
            Math.max(d.amount / mx * 100, 2) + '%;background:var(--snacks)"></div><div class="bar-label">' + d.day + '</div></div>'
        ).join('');
    } else {
        document.getElementById('wChart').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)">Weekly data will appear after the first sales</div>';
    }

    // Transactions
    document.getElementById('txC').textContent = todayTx.length;
    document.getElementById('txBody').innerHTML = todayTx.length ? todayTx.slice(0, 15).map(t =>
        '<tr><td style="white-space:nowrap">' + esc(t.time) + '</td><td style="font-weight:600">' + esc(t.camper) +
        '</td><td>' + esc(t.items) + '</td><td style="font-weight:700">$' + t.amount.toFixed(2) + '</td></tr>'
    ).join('') : '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted)">No transactions today</td></tr>';
}

// ==========================================================================
// MODALS & ACTIONS
// ==========================================================================

window.openM = function(n) { document.getElementById('m-' + n).classList.add('open'); if (n === 'dep' || n === 'limit') popSelects(); };
window.closeM = function(n) { document.getElementById('m-' + n).classList.remove('open'); };

function popSelects() {
    const opts = '<option value="">— Select —</option>' + camperList.map(c =>
        '<option value="' + esc(c.name) + '">' + esc(c.name) + ' (' + esc(c.division) + ')</option>'
    ).join('');
    const s1 = document.getElementById('depCamper');
    const s2 = document.getElementById('limCamper');
    if (s1) s1.innerHTML = opts;
    if (s2) s2.innerHTML = opts;

    const s3 = document.getElementById('rItem');
    if (s3) s3.innerHTML = '<option value="">— Select —</option>' + snacks.inventory.map(i =>
        '<option value="' + i.id + '">' + i.emoji + ' ' + esc(i.name) + ' (' + i.stock + ' in stock)</option>'
    ).join('');
}

window.addDep = function() {
    const name = document.getElementById('depCamper').value;
    const amt = parseFloat(document.getElementById('depAmt').value);
    if (!name || !amt || amt <= 0) { toast('Enter valid camper and amount', 1); return; }
    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    snacks.accounts[name].balance += amt;
    saveSnacksData(snacks);
    closeM('dep');
    renderStats(); rAccounts();
    toast('Added $' + amt.toFixed(2) + ' to ' + name);
    document.getElementById('depAmt').value = '';
    document.getElementById('depNote').value = '';
};

window.setLimit = function() {
    const name = document.getElementById('limCamper').value;
    const amt = parseFloat(document.getElementById('limAmt').value);
    if (!name || !amt) { toast('Enter valid info', 1); return; }
    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: 10, spentToday: 0 };
    snacks.accounts[name].dailyLimit = amt;
    saveSnacksData(snacks);
    closeM('limit');
    rAccounts();
    toast('Limit set to $' + amt.toFixed(2) + ' for ' + name);
};

window.addItem = function() {
    const name = document.getElementById('niName').value.trim();
    const cat = document.getElementById('niCat').value;
    const emoji = document.getElementById('niEmoji').value.trim() || '📦';
    const price = parseFloat(document.getElementById('niPrice').value);
    const stock = parseInt(document.getElementById('niStock').value) || 0;
    if (!name || !price) { toast('Fill required fields', 1); return; }
    const maxId = snacks.inventory.reduce((m, i) => Math.max(m, i.id || 0), 0);
    snacks.inventory.push({ id: maxId + 1, name, cat, emoji, price, stock, soldToday: 0, totalSold: 0 });
    saveSnacksData(snacks);
    closeM('item');
    rInventory(); renderStats(); rAnalytics();
    toast('Added ' + emoji + ' ' + name);
    ['niName', 'niEmoji', 'niPrice', 'niStock'].forEach(id => document.getElementById(id).value = '');
};

window.restock = function() {
    const iid = +document.getElementById('rItem').value;
    const qty = parseInt(document.getElementById('rQty').value);
    if (!iid || !qty) { toast('Select item and quantity', 1); return; }
    const item = snacks.inventory.find(i => i.id === iid);
    if (!item) return;
    item.stock += qty;
    saveSnacksData(snacks);
    closeM('restock');
    rInventory(); renderStats(); rAnalytics();
    toast('Restocked ' + item.emoji + ' ' + item.name + ' +' + qty);
};

// ==========================================================================
// UTILS
// ==========================================================================

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(m, e) {
    const el = document.getElementById('toast');
    el.textContent = m;
    el.className = 'toast show' + (e ? ' err' : '');
    setTimeout(() => el.className = 'toast', 2500);
}

// Expose for POS cross-reference
window.CampistrySnacks = {
    getSnacksData: () => snacks,
    saveSnacksData,
    getRoster,
    getCamperList,
    getAccount,
    loadSnacksData,
    refresh: () => { snacks = loadSnacksData(); ensureAccountsForRoster(); }
};

document.addEventListener('DOMContentLoaded', init);
})();
