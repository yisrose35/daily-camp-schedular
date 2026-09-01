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
// PAYMENT METHODS
//
// The catalogue and the debit stance are camp-wide policy, owned by
// campistry_payments.js — the canteen doesn't get its own opinion, or the
// office ends up with four screens disagreeing about what they take.
//
// The camp refuses debit on TUITION (chargeback/NSF exposure, no installment
// support), and the canteen inherits it. There's a second reason here on top:
// a canteen balance is prepaid money a camper can draw back out as cash (see
// cashOut below), which makes funding it from debit a cash-equivalent
// transaction.
//
// `on` is the out-of-the-box default; the office toggles these in Settings.
// ==========================================================================
function _payAPI() { return (typeof window !== 'undefined' && window.CampistryPayments) || null; }

function payMethodCatalogue() {
    const P = _payAPI();
    if (P) {
        // Everything valid in the canteen, with the camp's defaults applied.
        const enabled = P.forContext('canteen').map(m => m.id);
        return P.METHODS
            .filter(m => m.contexts.includes('canteen'))
            .map(m => ({ id: m.id, label: m.label, on: enabled.includes(m.id) }));
    }
    // Policy module missing — a minimal, safe fallback rather than no options.
    return [
        { id: 'cash', label: 'Cash', on: true },
        { id: 'credit', label: 'Credit card', on: true },
        { id: 'check', label: 'Check', on: true }
    ];
}
function blockedPayMethods() {
    const P = _payAPI();
    return P ? P.blockedFor('canteen') : [];
}
const PAY_METHODS = payMethodCatalogue();
const BLOCKED_PAY_METHODS = blockedPayMethods();

const DEFAULT_SNACKS_SETTINGS = {
    payMethods: PAY_METHODS.filter(m => m.on).map(m => m.id),
    defaultDailyLimit: 10,
    cashDailyMax: 20,           // per camper, per day; 0 = uncapped
    cashReasonRequired: true,
    cashAllowNegative: false    // off = a camper can't withdraw money they don't have
};

// ==========================================================================
// DATA LAYER — Read from Campistry Me, persist Snacks-specific data
// ==========================================================================

function readGlobal() {
    // STORE_KEY (campGlobalSettings_v1) is what campistry_cloud_bootstrap.js
    // actually hydrates from Supabase into — it must be checked FIRST.
    // CAMPISTRY_UNIFIED_STATE is only ever written by demo_mode.js (offline
    // expo mode) or the standalone registration page; if either of those was
    // ever visited in this browser, that key sits in localStorage
    // indefinitely and — when checked first — permanently shadows the real,
    // freshly-hydrated roster with stale/demo data. This was reported as
    // "campers not showing in Snacks" even after cloud hydration confirmed
    // finding real campers.
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

    cloudSaveSnacks(data);
}

// Signature used to dedupe transactions across the stale-local vs fresh-cloud
// merge (transactions carry no id).
function _txSig(t) {
    return [t.date, t.time, t.camper, t.type, t.amount, t.items].join('|');
}

// Recompute every account's balance from the (append-only) transaction ledger,
// which is the durable record. Preserves dailyLimit/spentToday/etc.
function _reconcileBalances(data) {
    if (!data || !data.accounts) return data;
    var byCamper = {};
    (data.transactions || []).forEach(function(t) {
        if (!t || !t.camper) return;
        var amt = parseFloat(t.amount) || 0;
        byCamper[t.camper] = (byCamper[t.camper] || 0) + (t.type === 'credit' ? amt : -amt);
    });
    Object.keys(data.accounts).forEach(function(name) {
        if (byCamper[name] != null) data.accounts[name].balance = Math.round(byCamper[name] * 100) / 100;
    });
    return data;
}

// Cloud write. campistrySnacks is a shared blob that a parent's SECURITY DEFINER
// deposit (migration 019, FOR UPDATE + merge) and the admin manager both write.
// The manager loads from possibly-stale LOCAL storage, so a naive full-blob
// upsert here can clobber a parent deposit that landed on the cloud after this
// tab cached its copy. Fetch the CURRENT cloud value first, union the
// transaction ledgers, then recompute balances from the union — so no deposit
// or purchase is ever lost, regardless of write order.
function cloudSaveSnacks(data) {
    try {
        const db = window.CampistryDB;
        const client = db && db.client;
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId) { _cloudUpsertSnacks(data); return; }
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                var cloud = (res && res.data && res.data.value) || null;
                var merged = data;
                if (cloud && typeof cloud === 'object') {
                    // Union transactions (cloud + local), deduped by signature.
                    var seen = {}, tx = [];
                    (data.transactions || []).concat(cloud.transactions || []).forEach(function(t) {
                        var s = _txSig(t); if (seen[s]) return; seen[s] = 1; tx.push(t);
                    });
                    merged = Object.assign({}, cloud, data);          // local wins for inventory/config
                    merged.accounts = Object.assign({}, cloud.accounts || {}, data.accounts || {});
                    merged.transactions = tx;
                    _reconcileBalances(merged);                        // balance := ledger truth
                }
                _cloudUpsertSnacks(merged);
                // Keep local mirror consistent with what we just wrote.
                try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = merged; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                snacks = merged;
            }, function() { _cloudUpsertSnacks(data); });
    } catch (e) { console.warn('[Snacks] Cloud save error:', e); _cloudUpsertSnacks(data); }
}

function _cloudUpsertSnacks(data) {
    if (window.saveGlobalSettings && window.saveGlobalSettings._isAuthoritativeHandler) {
        window.saveGlobalSettings('campistrySnacks', data);
        return;
    }
    try {
        const db = window.CampistryDB;
        if (!db || !db.client) return;
        const campId = db.getCampId && db.getCampId();
        if (!campId) return;
        db.client.from('camp_state_kv')
            .upsert({ camp_id: campId, key: 'campistrySnacks', value: data, updated_at: new Date().toISOString() }, { onConflict: 'camp_id,key' })
            .then(res => { if (res.error) console.warn('[Snacks] Cloud save failed:', res.error.message); });
    } catch (e) { console.warn('[Snacks] Cloud save error:', e); }
}

// ==========================================================================
// STATE
// ==========================================================================

let snacks = loadSnacksData();
let camperList = [];
// init() runs once immediately on page load (for instant UI, before this
// page's own cloud hydration has landed) and again after 'campistry-cloud-
// hydrated' fires with the real data. On that FIRST call the roster/snacks
// data can be empty or stale — real bug found live: ensureAccountsForRoster()
// saw an empty pre-hydration roster, deleted every account as "orphaned",
// and auto-saved that stale snapshot. cloudSaveSnacks's fetch-merge unions
// transactions/accounts but replaces inventory wholesale, so that one
// pre-hydration save silently wiped out inventory counters (soldToday/
// totalSold) a POS register had *just* correctly written to the cloud
// moments earlier. Block any auto-save until real data has loaded once.
let _hydratedOnce = false;

function ensureAccountsForRoster() {
    // Create snacks accounts for any campers in the roster that don't have one
    camperList = getCamperList();
    if (!snacks.accounts) snacks.accounts = {};
    let changed = false;
    const _dflt = getSettings().defaultDailyLimit;
    camperList.forEach(c => {
        if (!snacks.accounts[c.name]) {
            snacks.accounts[c.name] = { balance: 0, dailyLimit: _dflt, spentToday: 0 };
            changed = true;
        }
    });
    // Remove accounts for campers no longer in roster
    const rosterNames = new Set(camperList.map(c => c.name));
    Object.keys(snacks.accounts).forEach(name => {
        if (!rosterNames.has(name)) { delete snacks.accounts[name]; changed = true; }
    });
    // Guarded by _hydratedOnce — see its declaration for why: saving here
    // before real cloud data has loaded once can wholesale-overwrite fresh
    // inventory counters another device just wrote.
    if (changed && _hydratedOnce) saveSnacksData(snacks);
}

function getAccount(name) {
    const a = snacks.accounts[name] || { balance: 0, dailyLimit: getSettings().defaultDailyLimit, spentToday: 0 };
    // Daily spend resets at midnight
    const t = new Date();
    const today = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    if (a.lastSpendDate !== today) { a.spentToday = 0; a.lastSpendDate = today; }
    return a;
}

// ==========================================================================
// SETTINGS
// ==========================================================================

function getSettings() {
    const s = (snacks && snacks.settings) || {};
    const out = Object.assign({}, DEFAULT_SNACKS_SETTINGS, s);
    // A stored list could name a method we've since retired — or `debit`, if an
    // older build ever wrote one. Filter against the live catalogue.
    const valid = PAY_METHODS.map(m => m.id);
    out.payMethods = (Array.isArray(out.payMethods) ? out.payMethods : []).filter(id => valid.includes(id));
    if (!out.payMethods.length) out.payMethods = ['cash', 'credit'];
    return out;
}

function payMethodLabel(id) {
    const m = PAY_METHODS.find(x => x.id === id);
    return m ? m.label : (id || '—');
}

// The cash-out arithmetic lives in campistry_snacks_cash.js (pure + unit
// tested). These are thin adapters that feed it this page's state.

/** Cash paid out across the whole camp on a given date (defaults to today). */
function cashOutTotal(date) {
    return window.SnacksCash.paidOutOn(snacks.transactions, date || todayStr());
}

/** How much cash this camper may take out right now, and why not more. */
function cashOutLimit(name) {
    const cfg = getSettings();
    const lim = window.SnacksCash.limit({
        account: getAccount(name), transactions: snacks.transactions,
        camper: name, date: todayStr(), settings: cfg
    });
    lim.cfg = cfg;
    return lim;
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
    if (!snacks.settings) snacks.settings = Object.assign({}, DEFAULT_SNACKS_SETTINGS);

    renderStats();
    rAccounts();
    rInventory();
    rAnalytics();
    rSettings();
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
    // Sales = purchases only. A cash withdrawal moves money out of the account
    // without selling anything, and a deposit refund reverses money that was
    // never a sale in the first place — neither should count as revenue.
    const salesToday = (snacks.transactions || [])
        .filter(t => t.date === todayStr() && t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund')
        .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    document.getElementById('sS').textContent = '$' + salesToday.toFixed(0);
    const cashEl = document.getElementById('sC');
    if (cashEl) cashEl.textContent = '$' + cashOutTotal().toFixed(0);
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
        const jsName = esc(c.name).replace(/'/g, '&#39;');
        return '<tr><td style="font-weight:600">' + esc(c.name) + '</td><td>' + esc(c.division) + '</td><td>' + esc(c.bunk) +
            '</td><td style="font-weight:700;color:' + (a.balance <= 5 ? 'var(--red-600)' : 'var(--text-primary)') + '">$' + a.balance.toFixed(2) +
            '</td><td>$' + a.dailyLimit.toFixed(2) + '</td><td>$' + a.spentToday.toFixed(2) +
            '</td><td>' + st + '</td><td style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-primary" onclick="openMFor(\'dep\',\'depCamper\',\'' + jsName + '\')">+ Deposit</button> ' +
            '<button class="btn btn-sm btn-secondary" onclick="openMFor(\'cash\',\'cashCamper\',\'' + jsName + '\')">Cash Out</button> ' +
            '<button class="btn btn-sm btn-secondary" onclick="openMFor(\'refund\',\'refundCamper\',\'' + jsName + '\')">Refund</button>' +
            '</td></tr>';
    }).join('');
};

/** Open a modal with its camper select pre-filled (and its dependent UI refreshed). */
window.openMFor = function(modal, selectId, name) {
    openM(modal);
    const el = document.getElementById(selectId);
    if (el) el.value = name;
    if (modal === 'cash') cashPickCamper();
    if (modal === 'refund') refundPickCamper();
};

// ==========================================================================
// INVENTORY TAB
// ==========================================================================

function rInventory() {
    const I = snacks.inventory;
    document.getElementById('iCount').textContent = I.length + ' items';
    document.getElementById('iBody').innerHTML = I.map(i => {
        // stock == null means "not tracked" — always sellable, no count to
        // read as low/out. Only a real number gets the Out/Low/OK badge.
        const tracked = i.stock != null;
        let st;
        if (!tracked) st = '<span class="badge badge-neutral">Untracked</span>';
        else if (i.stock === 0) st = '<span class="badge badge-red">Out</span>';
        else if (i.stock <= 10) st = '<span class="badge badge-amber">Low</span>';
        else st = '<span class="badge badge-green">OK</span>';
        return '<tr><td style="font-weight:600">' + esc(i.name) +
            '</td><td><span class="badge badge-neutral">' + esc(i.cat) + '</span></td><td style="font-weight:600">$' + i.price.toFixed(2) +
            '</td><td style="font-weight:600;color:' + (!tracked ? 'var(--text-muted)' : i.stock === 0 ? 'var(--red-600)' : i.stock <= 10 ? 'var(--amber-600)' : 'var(--text-primary)') +
            '">' + (tracked ? i.stock : '—') + '</td><td>' + (i.soldToday || 0) + '</td><td>' + (i.totalSold || 0) + '</td><td>' + st +
            '</td><td><button class="btn btn-sm btn-secondary" onclick="openEditItem(' + i.id + ')">Edit</button></td></tr>';
    }).join('');
}

// ==========================================================================
// ANALYTICS TAB
// ==========================================================================

function rAnalytics() {
    const todayTx = (snacks.transactions || []).filter(t => t.date === todayStr());
    // Revenue and the "avg transaction" metric are about SALES. Deposits
    // (credits), cash withdrawals, and deposit refunds all move money but
    // sell nothing — a refund is a debit (money leaving the camp's ledger
    // back to the parent, same sign as a purchase) but it's the opposite of
    // a sale, so it has to be excluded here just like credits/cash-outs are.
    const saleTx = todayTx.filter(t => t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund');
    const sal = saleTx.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const tc = saleTx.length;
    const I = snacks.inventory;
    const units = I.reduce((s, i) => s + (i.soldToday || 0), 0);
    // Untracked items (stock == null) don't count toward either side of
    // sell-through — there's no capacity number to measure against.
    const openStock = I.reduce((s, i) => s + (i.stock != null ? i.stock + (i.soldToday || 0) : 0), 0);

    document.getElementById('mRev').textContent = '$' + sal.toFixed(2);
    document.getElementById('mTxn').textContent = tc + ' txns';
    document.getElementById('mAvg').textContent = tc ? '$' + (sal / tc).toFixed(2) : '$0';
    document.getElementById('mUnits').textContent = units;
    document.getElementById('mLow').textContent = I.filter(i => i.stock != null && i.stock <= 10).length;
    document.getElementById('mST').textContent = (openStock ? Math.round(units / openStock * 100) : 0) + '%';

    const top = [...I].sort((a, b) => (b.soldToday || 0) - (a.soldToday || 0))[0];
    document.getElementById('mTop').textContent = top ? top.name : '—';
    document.getElementById('mTopN').textContent = top ? (top.soldToday || 0) + ' today · ' + (top.totalSold || 0) + ' all-time' : '';

    // Popularity
    const ranked = [...I].sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0));
    const maxT = ranked[0]?.totalSold || 1;
    document.getElementById('popList').innerHTML = ranked.length ? ranked.map((i, x) =>
        '<div class="rank-item"><div class="rank-pos">' + (x + 1) +
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

    // Weekly chart — computed live from the transaction ledger. snacks.weeklyRevenue
    // was never actually written by anything (POS/RPC only ever touch accounts/
    // transactions/inventory), so it stayed permanently empty; derive it the same
    // way saleTx/salesToday already derive today's numbers instead.
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const WK = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const amt = (snacks.transactions || [])
            .filter(t => t.date === key && t.type !== 'credit' && t.kind !== 'cash_out' && t.kind !== 'refund')
            .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
        WK.push({ day: DOW[d.getDay()], amount: Math.round(amt * 100) / 100 });
    }
    if (WK.some(d => d.amount > 0)) {
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
    document.getElementById('txBody').innerHTML = todayTx.length ? todayTx.slice(0, 25).map(t => {
        const amt = Math.abs(parseFloat(t.amount) || 0);
        const credit = t.type === 'credit';
        const cashOut = t.kind === 'cash_out';
        const refund = t.kind === 'refund';
        const kind = refund  ? '<span class="badge badge-amber">Refund</span>'
                   : cashOut ? '<span class="badge badge-amber">Cash out</span>'
                   : credit  ? '<span class="badge badge-green">Deposit</span>'
                             : '<span class="badge badge-neutral">Purchase</span>';
        const color = credit ? 'var(--green-600)' : (cashOut || refund) ? 'var(--amber-600)' : 'var(--text-primary)';
        return '<tr><td style="white-space:nowrap">' + esc(t.time || '') + '</td><td style="font-weight:600">' + esc(t.camper || '') +
            '</td><td>' + esc(t.items || '') + '</td><td>' + kind +
            '</td><td style="font-weight:700;color:' + color + '">' + (credit ? '+' : '−') + '$' + amt.toFixed(2) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted)">No transactions today</td></tr>';
}

// ==========================================================================
// SETTINGS TAB
// ==========================================================================

function rSettings() {
    const cfg = getSettings();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('setDefaultLimit', cfg.defaultDailyLimit);
    set('setCashDailyMax', cfg.cashDailyMax);
    set('setCashReasonRequired', cfg.cashReasonRequired ? 'yes' : 'no');
    set('setCashAllowNegative', cfg.cashAllowNegative ? 'yes' : 'no');

    const box = document.getElementById('setPayMethods');
    if (box) {
        box.innerHTML = PAY_METHODS.map(m =>
            '<label class="pay-row"><input type="checkbox" data-pay="' + m.id + '"' +
            (cfg.payMethods.includes(m.id) ? ' checked' : '') + '><span>' + esc(m.label) + '</span></label>'
        ).join('') + BLOCKED_PAY_METHODS.map(m =>
            '<label class="pay-row blocked" title="' + esc(m.reason) + '"><input type="checkbox" disabled>' +
            '<span style="text-decoration:line-through">' + esc(m.label) + '</span>' +
            '<span class="pay-row-note">' + esc(m.reason) + '</span></label>'
        ).join('');
    }

    const drawer = document.getElementById('cashDrawerBox');
    if (drawer) {
        const today = todayStr();
        const outs = (snacks.transactions || []).filter(t => t.kind === 'cash_out' && t.date === today);
        const cashIn = (snacks.transactions || [])
            .filter(t => t.type === 'credit' && t.method === 'cash' && t.date === today)
            .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
        const cashOut = outs.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
        drawer.innerHTML =
            '<div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.85rem">' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Cash deposits in</div>' +
                    '<div style="font-size:1.15rem;font-weight:700;color:var(--green-600)">+$' + cashIn.toFixed(2) + '</div></div>' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Cash paid out</div>' +
                    '<div style="font-size:1.15rem;font-weight:700;color:var(--amber-600)">−$' + cashOut.toFixed(2) + '</div></div>' +
                '<div><div style="font-size:.72rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Net in drawer</div>' +
                    '<div style="font-size:1.15rem;font-weight:700">$' + (cashIn - cashOut).toFixed(2) + '</div></div>' +
            '</div>' +
            (outs.length
                ? '<div class="table-wrapper"><table class="data-table"><thead><tr><th>Time</th><th>Camper</th><th>Reason</th><th>By</th><th>Amount</th></tr></thead><tbody>' +
                  outs.map(t => '<tr><td style="white-space:nowrap">' + esc(t.time || '') + '</td><td style="font-weight:600">' + esc(t.camper || '') +
                      '</td><td>' + esc(t.note || '—') + '</td><td>' + esc(t.by || '—') +
                      '</td><td style="font-weight:700;color:var(--amber-600)">$' + Math.abs(parseFloat(t.amount) || 0).toFixed(2) + '</td></tr>').join('') +
                  '</tbody></table></div>'
                : '<div style="font-size:.82rem;color:var(--text-muted)">No cash paid out today.</div>');
    }
}

window.saveSettingsForm = function() {
    if (!_secEdit('settings', 'Saving settings')) return;
    const num = (id, dflt) => {
        const e = document.getElementById(id);
        const v = e ? parseFloat(e.value) : NaN;
        return isFinite(v) && v >= 0 ? v : dflt;
    };
    const picked = Array.from(document.querySelectorAll('#setPayMethods input[data-pay]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.pay);
    if (!picked.length) { toast('Keep at least one payment method', 1); return; }
    snacks.settings = Object.assign({}, getSettings(), {
        payMethods: picked,
        defaultDailyLimit: num('setDefaultLimit', DEFAULT_SNACKS_SETTINGS.defaultDailyLimit),
        cashDailyMax: num('setCashDailyMax', DEFAULT_SNACKS_SETTINGS.cashDailyMax),
        cashReasonRequired: (document.getElementById('setCashReasonRequired') || {}).value !== 'no',
        cashAllowNegative: (document.getElementById('setCashAllowNegative') || {}).value === 'yes'
    });
    saveSnacksData(snacks);
    rSettings(); popSelects();
    toast('Settings saved');
};

// ==========================================================================
// MODALS & ACTIONS
// ==========================================================================

window.openM = function(n) {
    document.getElementById('m-' + n).classList.add('open');
    if (n === 'dep' || n === 'limit' || n === 'cash') popSelects();
    if (n === 'cash') cashPickCamper();
};
window.closeM = function(n) { document.getElementById('m-' + n).classList.remove('open'); };

function popSelects() {
    const opts = '<option value="">— Select —</option>' + camperList.map(c =>
        '<option value="' + esc(c.name) + '">' + esc(c.name) + ' (' + esc(c.division) + ')</option>'
    ).join('');
    ['depCamper', 'limCamper', 'cashCamper', 'refundCamper'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const keep = el.value;                 // don't lose a selection on re-populate
        el.innerHTML = opts;
        if (keep) el.value = keep;
    });

    const s3 = document.getElementById('rItem');
    if (s3) s3.innerHTML = '<option value="">— Select —</option>' + snacks.inventory.map(i =>
        '<option value="' + i.id + '">' + esc(i.name) + (i.stock == null ? '' : ' (' + i.stock + ' in stock)') + '</option>'
    ).join('');

    // Deposit methods come from Settings — debit is never in this list.
    const pm = document.getElementById('depMethod');
    if (pm) {
        const cfg = getSettings();
        const keep = pm.value;
        pm.innerHTML = cfg.payMethods.map(id =>
            '<option value="' + esc(id) + '">' + esc(payMethodLabel(id)) + '</option>'
        ).join('');
        if (keep && cfg.payMethods.includes(keep)) pm.value = keep;
    }
}

window.addDep = function() {
    if (!_secEdit('accounts', 'Adding funds')) return;
    const name = document.getElementById('depCamper').value;
    const amt = parseFloat(document.getElementById('depAmt').value);
    const noteEl = document.getElementById('depNote');
    const methodEl = document.getElementById('depMethod');
    const note = noteEl ? (noteEl.value || '').trim() : '';
    const cfg = getSettings();
    let method = methodEl ? methodEl.value : 'cash';
    if (!name || !amt || amt <= 0) { toast('Enter valid camper and amount', 1); return; }
    // Belt and braces: a stale DOM (or a hand-edited option) can't smuggle in a
    // method the camp doesn't accept — debit included.
    if (!cfg.payMethods.includes(method)) { toast('That payment method isn\'t accepted', 1); return; }

    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: cfg.defaultDailyLimit, spentToday: 0 };
    const rounded = Math.round(amt * 100) / 100;
    snacks.accounts[name].balance = Math.round((snacks.accounts[name].balance + rounded) * 100) / 100;
    // The ledger is the durable record — _reconcileBalances() rebuilds every
    // balance from it, so a deposit that isn't written here gets erased by the
    // next cloud merge.
    if (!snacks.transactions) snacks.transactions = [];
    snacks.transactions.unshift({
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        camper: name, items: 'Deposit' + (note ? ' — ' + note : ''), amount: rounded,
        type: 'credit', kind: 'deposit', method: method, note: note, date: todayStr()
    });
    saveSnacksData(snacks);
    closeM('dep');
    renderStats(); rAccounts(); rAnalytics(); rSettings();
    toast('Added $' + rounded.toFixed(2) + ' to ' + name + ' (' + payMethodLabel(method) + ')');
    document.getElementById('depAmt').value = '';
    if (noteEl) noteEl.value = '';
};

// ==========================================================================
// CASH OUT — camper draws part of their canteen balance back as physical cash
// ==========================================================================

/** Refresh the balance box, quick-amount chips, warning and button state. */
window.cashPickCamper = function() {
    const name = (document.getElementById('cashCamper') || {}).value || '';
    const box = document.getElementById('cashBalBox');
    const warn = document.getElementById('cashWarn');
    const btn = document.getElementById('cashBtn');
    const quick = document.getElementById('cashQuick');
    const reqMark = document.getElementById('cashReasonReq');
    const cfg = getSettings();
    if (reqMark) reqMark.textContent = cfg.cashReasonRequired ? '*' : '';

    if (!name) {
        if (box) box.style.display = 'none';
        if (warn) warn.style.display = 'none';
        if (quick) quick.innerHTML = '';
        if (btn) btn.disabled = true;
        return;
    }
    const lim = cashOutLimit(name);
    if (box) {
        box.style.display = '';
        box.innerHTML =
            '<div>Balance: <strong>$' + lim.balance.toFixed(2) + '</strong></div>' +
            '<div>Available to take out: <strong>' + (lim.max === Infinity ? 'no limit' : '$' + lim.max.toFixed(2)) + '</strong></div>' +
            (lim.takenToday > 0 ? '<div style="color:var(--text-muted)">Already taken today: $' + lim.takenToday.toFixed(2) + '</div>' : '');
    }
    if (quick) {
        const caps = [5, 10, 20, 50].filter(v => lim.max === Infinity || v <= lim.max);
        quick.innerHTML = caps.map(v =>
            '<button type="button" class="btn btn-secondary btn-sm" onclick="cashQuickAmt(' + v + ')">$' + v + '</button>'
        ).join('') + (lim.max !== Infinity && lim.max > 0
            ? '<button type="button" class="btn btn-secondary btn-sm" onclick="cashQuickAmt(' + lim.max + ')">All ($' + lim.max.toFixed(2) + ')</button>'
            : '');
    }

    const amt = parseFloat((document.getElementById('cashAmt') || {}).value) || 0;
    let problem = '';
    if (lim.reason) problem = lim.reason;
    else if (amt > 0 && lim.max !== Infinity && amt > lim.max + 1e-9) {
        problem = 'Over the available $' + lim.max.toFixed(2);
    }
    if (warn) { warn.style.display = problem ? '' : 'none'; warn.textContent = problem; }
    if (btn) btn.disabled = !!problem || amt <= 0;
};

window.cashQuickAmt = function(v) {
    const el = document.getElementById('cashAmt');
    if (el) { el.value = Number(v).toFixed(2); cashPickCamper(); }
};

window.cashOut = function() {
    if (!_secEdit('accounts', 'Paying out cash')) return;
    const name = (document.getElementById('cashCamper') || {}).value || '';
    const amt = parseFloat((document.getElementById('cashAmt') || {}).value);
    const note = ((document.getElementById('cashNote') || {}).value || '').trim();
    const by = ((document.getElementById('cashBy') || {}).value || '').trim();
    const cfg = getSettings();
    // Re-validate at write time. The modal can sit open while a POS charge
    // lands from another device, so the number the office saw may be stale.
    const check = window.SnacksCash.validate({
        account: getAccount(name), transactions: snacks.transactions,
        camper: name, date: todayStr(), settings: cfg,
        amount: amt, note: note
    });
    if (!check.ok) { toast(check.error, 1); cashPickCamper(); return; }
    const rounded = check.amount;

    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: cfg.defaultDailyLimit, spentToday: 0 };
    snacks.accounts[name].balance = Math.round((snacks.accounts[name].balance - rounded) * 100) / 100;
    if (!snacks.transactions) snacks.transactions = [];
    // spentToday is deliberately untouched: dailyLimit caps canteen SPENDING,
    // and cash out has its own cap (cashDailyMax).
    snacks.transactions.unshift(window.SnacksCash.buildTransaction({
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        camper: name, amount: rounded, note: note, by: by, date: todayStr()
    }));
    saveSnacksData(snacks);
    closeM('cash');
    renderStats(); rAccounts(); rAnalytics(); rSettings();
    toast('Paid out $' + rounded.toFixed(2) + ' cash to ' + name);
    ['cashAmt', 'cashNote'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
};

// ==========================================================================
// REFUNDS — Stripe-backed deposits only (migrations/079_canteen_stripe_deposits.sql).
// A manual/cash deposit (addDep above) has no PaymentIntent, so it never
// appears in this list — there's nothing for Stripe to refund. Real
// authorization (owner/admin only) is enforced server-side in
// stripe-canteen-refund, not here — _secEdit is the same UX-level gate the
// rest of this tab already uses, not the security boundary.
// ==========================================================================

function _stripeDeposits(name) {
    return (snacks.transactions || []).filter(t =>
        t && t.camper === name && t.kind === 'deposit' && t.method === 'stripe' && t.stripePaymentIntentId
    );
}

// How much of this camper's balance can actually be refunded THROUGH STRIPE
// — mirrors the edge function's own math client-side, purely for display:
// each Stripe deposit's original amount minus whatever's already been
// refunded from that same PaymentIntent (a cash/manual deposit has no
// PaymentIntent at all, so it can never contribute here).
function _stripeRefundCapacity(name) {
    const txs = snacks.transactions || [];
    return Math.round(_stripeDeposits(name).reduce((sum, dep) => {
        const refundedSoFar = txs.filter(t => t && t.kind === 'refund' && t.stripePaymentIntentId === dep.stripePaymentIntentId)
            .reduce((s, t) => s + (Number(t.amount) || 0), 0);
        return sum + Math.max(0, Number(dep.amount) - refundedSoFar);
    }, 0) * 100) / 100;
}

window.refundPickCamper = function() {
    const name = (document.getElementById('refundCamper') || {}).value || '';
    const box = document.getElementById('refundBox');
    const amtInput = document.getElementById('refundAmt');
    const btn = document.getElementById('refundBtn');
    if (!box || !amtInput) return;
    if (!name) {
        box.style.display = 'none';
        amtInput.value = ''; amtInput.max = '';
        if (btn) btn.disabled = true;
        return;
    }
    const a = getAccount(name);
    const walletAvailable = Math.max(0, Math.round((a.balance - (a.balanceFloor || 0)) * 100) / 100);
    const capacity = _stripeRefundCapacity(name);
    const max = Math.min(walletAvailable, capacity);

    box.style.display = '';
    box.innerHTML =
        '<div>Available to refund via Stripe: <strong>$' + max.toFixed(2) + '</strong></div>' +
        (capacity < walletAvailable
            ? '<div style="color:var(--text-muted);margin-top:2px;">$' + (walletAvailable - capacity).toFixed(2) + ' of this balance came from a cash/manual deposit — refund that portion separately, it can\'t go through Stripe.</div>'
            : '');
    amtInput.max = String(max);
    amtInput.value = max > 0 ? max.toFixed(2) : '';
    if (btn) btn.disabled = max <= 0;
};

// Fills the amount field with everything currently refundable — the
// "send back all leftover money" shortcut. Just a convenience preset on
// top of the same free-text amount field, not a separate code path.
window.refundSetMax = function() {
    const amtInput = document.getElementById('refundAmt');
    if (amtInput && amtInput.max) amtInput.value = Number(amtInput.max).toFixed(2);
    refundAmtChanged();
};

window.refundAmtChanged = function() {
    const amtInput = document.getElementById('refundAmt');
    const btn = document.getElementById('refundBtn');
    if (!amtInput || !btn) return;
    const max = Number(amtInput.max) || 0;
    const val = Number(amtInput.value) || 0;
    btn.disabled = !(val > 0 && val <= max + 0.001); // small epsilon for float rounding
};

// supabase-js's functions.invoke() collapses EVERY non-2xx response into the
// same generic "Edge Function returned a non-2xx status code" on res.error.message
// — the real { error: "..." } body this and every other edge function in this
// app actually returns lands on res.error.context instead (a raw Response
// object nothing here was unwrapping). Without this, every deliberate,
// specific error message written server-side (missing field, nothing left
// to refund, cash-only balance, etc.) was invisible — the office only ever
// saw the useless generic string.
async function _edgeFnErrorMessage(res) {
    var data = res && res.data;
    if (data && data.error) return data.error;
    var err = res && res.error;
    if (!err) return null;
    try {
        if (err.context && typeof err.context.json === 'function') {
            var body = await err.context.json();
            if (body && body.error) return body.error;
        }
    } catch (_) { /* context wasn't JSON — fall through to the generic message */ }
    return err.message || String(err);
}

window.refundCanteenDeposit = function() {
    if (!_secEdit('accounts', 'Refunding a deposit')) return;
    const name = (document.getElementById('refundCamper') || {}).value || '';
    const amount = Number((document.getElementById('refundAmt') || {}).value) || 0;
    const warn = document.getElementById('refundWarn');
    const btn = document.getElementById('refundBtn');
    if (!name || !(amount > 0)) { toast('Pick a camper and an amount', 1); return; }
    const db = window.CampistryDB;
    const client = db && db.client;
    if (!client) { toast('Not signed in', 1); return; }
    if (warn) warn.style.display = 'none';
    if (btn) { btn.disabled = true; btn.textContent = 'Refunding…'; }
    client.functions.invoke('stripe-canteen-refund', { body: { camperName: name, amount: amount } })
        .then(async function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Refund'; }
            var data = res && res.data;
            var hasError = !!(res && res.error) || !!(data && data.error);
            var err = hasError ? await _edgeFnErrorMessage(res) : null;
            if (err) {
                if (warn) { warn.style.display = ''; warn.textContent = err; }
                else toast(err, 1);
                return;
            }
            closeM('refund');
            var acrossN = (data.refunds || []).length;
            toast('Refunded $' + Number(data.totalRefunded).toFixed(2) + ' to ' + name +
                (acrossN > 1 ? ' (across ' + acrossN + ' deposits)' : '') +
                (data.capped && data.cappedReason ? ' — ' + data.cappedReason : ''));
            _refreshSnacksFromCloud();
        }, function(e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Refund'; }
            var msg = (e && e.message) || 'Could not process the refund.';
            if (warn) { warn.style.display = ''; warn.textContent = msg; }
            else toast(msg, 1);
        });
};

// ── Refund All — every camper's leftover Stripe-paid balance in one go ─────
// Client-side preview mirrors the edge function's own math exactly (walletAvailable
// vs stripeCapacity) so the confirm screen shows a real number, not a guess —
// the server is still the one that actually decides/executes it.
function _refundAllPreview() {
    var total = 0, count = 0;
    (camperList || []).forEach(function(c) {
        var a = getAccount(c.name);
        var walletAvailable = Math.max(0, Math.round((a.balance - (a.balanceFloor || 0)) * 100) / 100);
        var capacity = _stripeRefundCapacity(c.name);
        var amt = Math.round(Math.min(walletAvailable, capacity) * 100) / 100;
        if (amt > 0) { total = Math.round((total + amt) * 100) / 100; count++; }
    });
    return { total: total, count: count };
}

window.openRefundAllModal = function() {
    if (!_secEdit('accounts', 'Refunding all canteen balances')) return;
    var body = document.getElementById('refundAllBody');
    var btn = document.getElementById('refundAllBtn');
    var resultEl = document.getElementById('refundAllResult');
    if (resultEl) resultEl.style.display = 'none';
    var preview = _refundAllPreview();
    if (!body) return;
    if (!preview.count) {
        body.innerHTML = '<p>No campers currently have a Stripe-paid balance to refund.</p>';
        if (btn) btn.style.display = 'none';
    } else {
        body.innerHTML =
            '<p>This will refund <strong>' + preview.count + ' camper' + (preview.count === 1 ? '' : 's') +
            '</strong>, totaling approximately <strong>$' + preview.total.toFixed(2) + '</strong> — sent back to whatever each parent originally paid with.</p>' +
            '<p style="color:var(--text-muted);">Only Stripe-paid deposits are included. A balance that came entirely from a cash/manual deposit is skipped — refund that by hand.</p>' +
            '<p style="color:var(--red-600);font-weight:600;">This cannot be undone.</p>';
        if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Refund All ($' + preview.total.toFixed(2) + ')'; }
    }
    openM('refundall');
};

window.refundAllCanteenDeposits = function() {
    if (!_secEdit('accounts', 'Refunding all canteen balances')) return;
    var btn = document.getElementById('refundAllBtn');
    var resultEl = document.getElementById('refundAllResult');
    var db = window.CampistryDB;
    var client = db && db.client;
    if (!client) { toast('Not signed in', 1); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Refunding everyone…'; }
    if (resultEl) resultEl.style.display = 'none';
    client.functions.invoke('stripe-canteen-refund-all', { body: {} })
        .then(async function(res) {
            var data = res && res.data;
            var hasError = !!(res && res.error) || !!(data && data.error);
            var err = hasError ? await _edgeFnErrorMessage(res) : null;
            if (err) {
                if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
                if (resultEl) { resultEl.style.display = ''; resultEl.style.color = 'var(--red-600)'; resultEl.textContent = err; }
                return;
            }
            if (btn) btn.style.display = 'none';
            var msg = 'Refunded $' + Number(data.totalRefunded).toFixed(2) + ' across ' + data.refundedCount + ' camper' + (data.refundedCount === 1 ? '' : 's') + '.';
            if (data.skippedCount) msg += ' ' + data.skippedCount + ' skipped (no Stripe-paid balance).';
            if (data.failedCount) msg += ' ' + data.failedCount + ' hit an error — check with the parent or try that camper individually.';
            if (resultEl) { resultEl.style.display = ''; resultEl.style.color = data.failedCount ? 'var(--red-600)' : '#16A34A'; resultEl.textContent = msg; }
            _refreshSnacksFromCloud();
        }, function(e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
            var msg = (e && e.message) || 'Could not process refunds.';
            if (resultEl) { resultEl.style.display = ''; resultEl.style.color = 'var(--red-600)'; resultEl.textContent = msg; }
        });
};

// The refund's balance/transaction change happens server-side (the RPC), not
// via saveSnacksData's push-and-merge path — pull the fresh row directly so
// the UI reflects it immediately instead of waiting on whatever polling/
// realtime sync interval the rest of the app relies on.
function _refreshSnacksFromCloud() {
    try {
        const db = window.CampistryDB;
        const client = db && db.client;
        const campId = db && db.getCampId && db.getCampId();
        if (!client || !campId) return;
        client.from('camp_state_kv').select('value').eq('camp_id', campId).eq('key', 'campistrySnacks').maybeSingle()
            .then(function(res) {
                var cloud = res && res.data && res.data.value;
                if (!cloud || typeof cloud !== 'object') return;
                snacks = cloud;
                try { var g = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); g.campistrySnacks = cloud; localStorage.setItem(STORE_KEY, JSON.stringify(g)); } catch (_) {}
                renderStats(); rAccounts(); rAnalytics(); rSettings();
            });
    } catch (e) { console.warn('[Snacks] refresh after refund failed:', e); }
}

window.setLimit = function() {
    if (!_secEdit('accounts', 'Changing a spending limit')) return;
    const name = document.getElementById('limCamper').value;
    const amt = parseFloat(document.getElementById('limAmt').value);
    if (!name || !amt) { toast('Enter valid info', 1); return; }
    if (!snacks.accounts[name]) snacks.accounts[name] = { balance: 0, dailyLimit: getSettings().defaultDailyLimit, spentToday: 0 };
    snacks.accounts[name].dailyLimit = amt;
    saveSnacksData(snacks);
    closeM('limit');
    rAccounts();
    toast('Limit set to $' + amt.toFixed(2) + ' for ' + name);
};

// _editingItemId is null while the modal is in "Add Item" mode, or the id
// of the item being edited when opened via openEditItem(). Both open the
// same modal/form — saveItem() branches on this instead of duplicating it.
let _editingItemId = null;

// Category is free text, not a fixed enum — offices can create their own
// categories (e.g. "Merch", "Candy") on top of the Snack/Drink/Treat
// starting suggestions. The datalist is just autocomplete; any string typed
// is accepted, both here and in the bulk upload template.
function _refreshCatSuggestions() {
    const dl = document.getElementById('niCatList');
    if (!dl) return;
    const seen = new Set();
    const cats = [];
    ['Snack', 'Drink', 'Treat'].concat(snacks.inventory.map(i => i.cat).filter(Boolean)).forEach(c => {
        const key = c.toLowerCase();
        if (!seen.has(key)) { seen.add(key); cats.push(c); }
    });
    dl.innerHTML = cats.map(c => '<option value="' + esc(c) + '">').join('');
}

// Stock is optional — blank means "not tracked" (always sellable, no count
// shown), not zero (which would read as out-of-stock). Stored as `null`
// rather than omitted so every read site has one consistent check
// (`item.stock == null`) instead of guessing at a missing key.
function _readStockField(id) {
    const raw = document.getElementById(id).value.trim();
    if (raw === '') return null;
    const n = parseInt(raw);
    return isNaN(n) ? null : n;
}

window.openAddItem = function() {
    _editingItemId = null;
    ['niName', 'niBarcode', 'niCat', 'niPrice', 'niStock'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    _refreshCatSuggestions();
    document.getElementById('itemModalTitle').textContent = 'Add Item';
    document.getElementById('itemSaveBtn').textContent = 'Add Item';
    openM('item');
};

window.openEditItem = function(id) {
    if (!_secEdit('menu', 'Editing an item')) return;
    const item = snacks.inventory.find(i => i.id === id);
    if (!item) return;
    _editingItemId = id;
    _refreshCatSuggestions();
    document.getElementById('niName').value = item.name;
    document.getElementById('niBarcode').value = item.barcode || '';
    document.getElementById('niCat').value = item.cat;
    document.getElementById('niPrice').value = item.price;
    document.getElementById('niStock').value = item.stock == null ? '' : item.stock;
    document.getElementById('itemModalTitle').textContent = 'Edit Item';
    document.getElementById('itemSaveBtn').textContent = 'Save Changes';
    openM('item');
};

window.saveItem = function() {
    if (!_secEdit('menu', _editingItemId ? 'Editing an item' : 'Adding an item')) return;
    const name = document.getElementById('niName').value.trim();
    const barcode = document.getElementById('niBarcode').value.trim();
    const cat = document.getElementById('niCat').value.trim();
    const price = parseFloat(document.getElementById('niPrice').value);
    const stock = _readStockField('niStock');
    if (!name || !price || !cat) { toast('Fill required fields', 1); return; }
    if (barcode && snacks.inventory.some(i => i.barcode === barcode && i.id !== _editingItemId)) {
        toast('That barcode is already assigned to another item', 1);
        return;
    }

    if (_editingItemId) {
        const item = snacks.inventory.find(i => i.id === _editingItemId);
        if (!item) return;
        item.name = name; item.cat = cat; item.price = price;
        if (stock == null) delete item.stock; else item.stock = stock;
        if (barcode) item.barcode = barcode; else delete item.barcode;
        saveSnacksData(snacks);
        closeM('item');
        rInventory(); renderStats(); rAnalytics();
        toast('Updated ' + name);
    } else {
        const maxId = snacks.inventory.reduce((m, i) => Math.max(m, i.id || 0), 0);
        const newItem = { id: maxId + 1, name, cat, price, soldToday: 0, totalSold: 0 };
        if (stock != null) newItem.stock = stock;
        if (barcode) newItem.barcode = barcode;
        snacks.inventory.push(newItem);
        saveSnacksData(snacks);
        closeM('item');
        rInventory(); renderStats(); rAnalytics();
        toast('Added ' + name);
    }
    _editingItemId = null;
    ['niName', 'niBarcode', 'niCat', 'niPrice', 'niStock'].forEach(id => document.getElementById(id).value = '');
};

window.restock = function() {
    if (!_secEdit('menu', 'Restocking')) return;
    const iid = +document.getElementById('rItem').value;
    const qty = parseInt(document.getElementById('rQty').value);
    if (!iid || !qty) { toast('Select item and quantity', 1); return; }
    const item = snacks.inventory.find(i => i.id === iid);
    if (!item) return;
    // Restocking an untracked (stock: null) item starts tracking it from 0.
    item.stock = (item.stock || 0) + qty;
    saveSnacksData(snacks);
    closeM('restock');
    rInventory(); renderStats(); rAnalytics();
    toast('Restocked ' + item.name + ' +' + qty);
};

// ==========================================================================
// BULK UPLOAD — Excel/CSV import for menu items (Name, Category, Price,
// Stock). Matches by name (case-insensitive) to decide add vs. update, so
// re-uploading the same sheet after editing prices is safe and idempotent.
// ==========================================================================

let _uploadParsedRows = null;

window.openUploadModal = function() {
    if (!_secEdit('menu', 'Uploading items')) return;
    document.getElementById('uploadFile').value = '';
    document.getElementById('uploadPreview').innerHTML = '';
    document.getElementById('uploadConfirmBtn').disabled = true;
    _uploadParsedRows = null;
    openM('upload');
};

window.downloadItemTemplate = function() {
    const ws = XLSX.utils.aoa_to_sheet([
        ['Name', 'Category', 'Price', 'Stock'],
        ['Gatorade', 'Drink', 2, 100],
        ['Chips', 'Snack', 1.5, ''],
        ['Candy Bar', 'Custom', 1, ''],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    XLSX.writeFile(wb, 'campistry-menu-items-template.xlsx');
};

window.handleUploadFile = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            _processUploadRows(rows);
        } catch (err) {
            toast('Could not read that file — make sure it\'s a valid Excel or CSV file', 1);
        }
    };
    reader.readAsArrayBuffer(file);
};

function _processUploadRows(rows) {
    // Skip a header row if the first cell reads like "Name".
    let startIdx = 0;
    if (rows.length && String(rows[0][0] || '').trim().toLowerCase() === 'name') startIdx = 1;

    const parsed = [];
    for (let r = startIdx; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !row.length || row.every(c => c === '' || c == null)) continue;
        const name = String(row[0] || '').trim();
        const cat = String(row[1] || '').trim();
        const priceRaw = row[2];
        const stockRaw = row[3];

        let error = null;
        if (!name) error = 'Missing name';
        if (!error && !cat) error = 'Missing category';
        const price = parseFloat(priceRaw);
        if (!error && (isNaN(price) || price <= 0)) error = 'Invalid price';
        let stock = null;
        if (stockRaw !== '' && stockRaw != null) {
            const n = parseInt(stockRaw);
            stock = isNaN(n) ? null : n;
        }

        const existing = snacks.inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
        parsed.push({
            row: r + 1, name, cat, price, stock, error,
            action: error ? 'error' : (existing ? 'update' : 'add'),
            existingId: existing ? existing.id : null,
        });
    }
    _uploadParsedRows = parsed;
    _renderUploadPreview(parsed);
}

function _renderUploadPreview(parsed) {
    if (!parsed.length) {
        document.getElementById('uploadPreview').innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-muted)">No rows found in that file.</div>';
        document.getElementById('uploadConfirmBtn').disabled = true;
        return;
    }
    const errs = parsed.filter(r => r.error).length;
    const adds = parsed.filter(r => r.action === 'add').length;
    const upds = parsed.filter(r => r.action === 'update').length;
    const rowsHtml = parsed.map(r => {
        const statusHtml = r.error
            ? '<span class="badge badge-red">' + esc(r.error) + '</span>'
            : (r.action === 'update' ? '<span class="badge badge-amber">Update</span>' : '<span class="badge badge-green">New</span>');
        return '<tr><td>' + r.row + '</td><td>' + esc(r.name || '—') + '</td><td>' + esc(r.cat || '—') + '</td><td>' +
            (isNaN(r.price) ? '—' : '$' + r.price.toFixed(2)) + '</td><td>' + (r.stock == null ? '—' : r.stock) +
            '</td><td>' + statusHtml + '</td></tr>';
    }).join('');
    document.getElementById('uploadPreview').innerHTML =
        '<div style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.5rem">' + adds + ' new, ' + upds + ' to update' +
        (errs ? ', ' + errs + ' with errors (skipped)' : '') + '</div>' +
        '<div class="table-wrapper" style="max-height:280px;overflow-y:auto"><table class="data-table"><thead><tr><th>Row</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    document.getElementById('uploadConfirmBtn').disabled = (adds + upds) === 0;
}

window.confirmUploadImport = function() {
    if (!_secEdit('menu', 'Uploading items')) return;
    if (!_uploadParsedRows) return;
    let maxId = snacks.inventory.reduce((m, i) => Math.max(m, i.id || 0), 0);
    let added = 0, updated = 0;
    _uploadParsedRows.forEach(r => {
        if (r.error) return;
        if (r.action === 'update') {
            const item = snacks.inventory.find(i => i.id === r.existingId);
            if (!item) return;
            item.name = r.name; item.cat = r.cat; item.price = r.price;
            if (r.stock == null) delete item.stock; else item.stock = r.stock;
            updated++;
        } else {
            maxId++;
            const newItem = { id: maxId, name: r.name, cat: r.cat, price: r.price, soldToday: 0, totalSold: 0 };
            if (r.stock != null) newItem.stock = r.stock;
            snacks.inventory.push(newItem);
            added++;
        }
    });
    saveSnacksData(snacks);
    closeM('upload');
    rInventory(); renderStats(); rAnalytics();
    toast('Imported ' + added + ' new, updated ' + updated + ' item' + ((added + updated) === 1 ? '' : 's'));
};

// ==========================================================================
// UTILS
// ==========================================================================

// ── Section access gates ─────────────────────────────────────────
// campistry_access_sections.js disables controls inside a view-only section,
// but a stale DOM or an inline handler on a non-control element can still
// reach these. Each write path checks explicitly.
function _secEdit(section, whatFor) {
    var S = window.CampistrySections;
    return S ? S.requireEdit(section, whatFor) : true;
}
function _secCan(section) {
    var S = window.CampistrySections;
    return S ? S.can(section) : true;
}

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
    // Settings + cash-drawer helpers, shared with the POS terminal.
    getSettings,
    payMethodLabel,
    PAY_METHODS,
    BLOCKED_PAY_METHODS,
    cashOutLimit,
    cashOutTotal,
    refresh: () => { snacks = loadSnacksData(); ensureAccountsForRoster(); }
};

document.addEventListener('DOMContentLoaded', init);

// The roster (app1.camperRoster) and this page's own campistrySnacks data
// both hydrate from the cloud asynchronously, shortly AFTER DOMContentLoaded
// fires. init() above runs before that hydration lands, so on a fresh page
// load it was reading an empty/stale roster — 0 campers shown, permanently
// (nothing ever re-ran init() afterward). Re-run once hydration completes.
window.addEventListener('campistry-cloud-hydrated', function () {
    console.log('[Snacks Manager] Cloud hydrated — reloading roster + snacks data');
    try {
        var db = window.CampistryDB;
        var campId = db && db.getCampId && db.getCampId();
        var stored = JSON.parse(localStorage.getItem('campGlobalSettings_v1') || '{}');
        var invSummary = ((stored.campistrySnacks && stored.campistrySnacks.inventory) || [])
            .filter(function (i) { return (i.soldToday || 0) > 0 || (i.totalSold || 0) > 0; })
            .map(function (i) { return i.name + ':' + i.soldToday + '/' + i.totalSold; });
        console.log('[Snacks Manager DEBUG] campId=', campId, 'campGlobalSettings_v1.campistrySnacks.inventory deltas:', invSummary);
    } catch (e) { console.log('[Snacks Manager DEBUG] inspection failed:', e); }
    snacks = loadSnacksData();
    try {
        var afterSummary = (snacks.inventory || [])
            .filter(function (i) { return (i.soldToday || 0) > 0 || (i.totalSold || 0) > 0; })
            .map(function (i) { return i.name + ':' + i.soldToday + '/' + i.totalSold; });
        console.log('[Snacks Manager DEBUG] loadSnacksData() returned inventory deltas:', afterSummary);
    } catch (e) {}
    _hydratedOnce = true;
    init();
});
})();
